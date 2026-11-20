import { loadMatch } from '../../../worker/feed/routes.js';
import { BINGO } from '../../../src/engine/collect/rules.js';
import { resultOf } from '../src/lib/bingoSlate.js';
import { weekBounds, nextEditableWeek, weeklyCatalog, validateWeeklyCard, scoreWeeklyCard, matchHit, rosterEvidence, WEEKLY_SQUARES, MATCH_LEAD_TIME } from '../src/lib/weeklyBingo.js';
import { ensureWallet } from './wallet.js';

const now = () => Math.floor(Date.now()/1000);
const reply = (body,status=200) => Response.json(body,{status,headers:{'Cache-Control':'private, no-store'}});
const parse = row => ({...row,cells:JSON.parse(row.cells)});
async function schedule(db,from,to) {
  const {results}=await db.prepare(`SELECT match_id AS matchId,best_of AS bestOf,starts_at AS startsAt,status,team1_tag AS team1Tag,team2_tag AS team2Tag
    FROM feed_matches WHERE starts_at>=? AND starts_at<? AND COALESCE(first_seen_at,0)<=starts_at-? ORDER BY starts_at,match_id`).bind(from,to,MATCH_LEAD_TIME).all();
  return results;
}
async function catalogFor(db,games) {
  const rows=(await db.prepare(`SELECT square,exposure,SUM(hits) AS hits,SUM(trials) AS trials
    FROM bingo_observations GROUP BY square,exposure`).all()).results;
  return weeklyCatalog(games,rows);
}
export async function ensureWeek(db,key,t=now()) {
  const bounds=weekBounds(key);
  if (!bounds) return null;
  const [from,to]=bounds;
  let row=await db.prepare('SELECT * FROM weekly_bingo_weeks WHERE week=?').bind(key).first();
  if (!row) {
    const games=await schedule(db,from,to);
    const calibrated=await db.prepare('SELECT payout_rate FROM bingo_calibration WHERE passed=1 ORDER BY id DESC LIMIT 1').first();
    const paid=!!calibrated && t<from;
    await db.prepare(`INSERT INTO weekly_bingo_weeks(week,starts_at,ends_at,schedule,catalog,payout_rate,paid_enabled,locked_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`).bind(key,from,to,JSON.stringify(games),JSON.stringify(await catalogFor(db,games)),paid?calibrated.payout_rate:1,paid?1:0,t>=to?t:null).run();
    row=await db.prepare('SELECT * FROM weekly_bingo_weeks WHERE week=?').bind(key).first();
  }
  if (t<to || !row.locked_at) {
    const games=await schedule(db,from,to);
    const frozen=JSON.stringify(games),lockedAt=t>=to?(row.locked_at??t):null;
    if (frozen!==row.schedule || lockedAt!==row.locked_at) {
      const catalog=JSON.stringify(await catalogFor(db,games));
      await db.prepare('UPDATE weekly_bingo_weeks SET schedule=?,catalog=?,locked_at=? WHERE week=?')
        .bind(frozen,catalog,lockedAt,key).run();
      row={...row,schedule:frozen,catalog,locked_at:lockedAt};
    }
  }
  return {...row,matches:JSON.parse(row.schedule),points:JSON.parse(row.catalog)};
}
async function cards(db,userId,key) {
  return (await db.prepare('SELECT slot,cells,version,updated_at,locked_at,catalog FROM weekly_bingo_cards WHERE user_id=? AND week=? ORDER BY slot').bind(userId,key).all()).results.map(r=>({...parse(r),catalog:r.catalog?JSON.parse(r.catalog):null}));
}
export async function weeklyContext(db,week,t=now()) {
  const results={};
  for (const m of week.matches) {
    const fresh=await loadMatch({DB:db},m.matchId);
    results[m.matchId]=!fresh||fresh.startsAt<week.starts_at||fresh.startsAt>=week.ends_at ? {state:'void'} : resultOf(fresh,t);
  }
  const rosterEvents=(await db.prepare(`SELECT change_type AS changeType,player,team,old_end AS oldEnd,new_end AS newEnd,source_url AS sourceUrl,first_seen_at AS firstSeenAt
    FROM roster_events WHERE first_seen_at>=? AND first_seen_at<? ORDER BY first_seen_at`).bind(week.starts_at,week.ends_at).all()).results;
  const checks=(await db.prepare('SELECT observed_at FROM roster_source_checks WHERE observed_at>=? AND observed_at<=? ORDER BY observed_at')
    .bind(week.starts_at-7200,week.ends_at+7200).all()).results.map(r=>r.observed_at);
  const coverage=checks.length>=2 && checks[0]<=week.starts_at && checks.at(-1)>=week.ends_at
    && checks.every((x,i)=>i===0||x-checks[i-1]<=3*3600);
  return {results,rosterEvents,rosterComplete:coverage && t>=week.ends_at};
}
async function scored(db,userId,week,t=now()) {
  const mine=await cards(db,userId,week.week);
  const ctx=await weeklyContext(db,week,t);
  return {cards:mine.map(c=>({slot:c.slot,...scoreWeeklyCard(c.cells,week.matches,ctx.results,ctx.rosterEvents,c.catalog??week.points,ctx.rosterComplete,c.locked_at??c.updated_at,t>=week.ends_at)})),rosterComplete:ctx.rosterComplete};
}
async function board(db,week,t) {
  const rows=(await db.prepare(`SELECT c.user_id,u.username,c.slot,c.cells,c.catalog,c.locked_at,c.updated_at FROM weekly_bingo_cards c JOIN users u ON u.id=c.user_id WHERE c.week=?`).bind(week.week).all()).results;
  const ctx=await weeklyContext(db,week,t);
  const totals=new Map();
  for (const row of rows) {
    const score=scoreWeeklyCard(JSON.parse(row.cells),week.matches,ctx.results,ctx.rosterEvents,row.catalog?JSON.parse(row.catalog):week.points,ctx.rosterComplete,row.locked_at??row.updated_at,t>=week.ends_at);
    const prev=totals.get(row.user_id)??{userId:row.user_id,username:row.username,points:0,firstLineAt:null};
    prev.points+=score.total;
    if (score.firstLineAt!=null) prev.firstLineAt=prev.firstLineAt==null?score.firstLineAt:Math.min(prev.firstLineAt,score.firstLineAt);
    totals.set(row.user_id,prev);
  }
  const entries=[...totals.values()].filter(x=>x.points>0).sort((a,b)=>b.points-a.points||(a.firstLineAt??Infinity)-(b.firstLineAt??Infinity)||a.username.localeCompare(b.username));
  entries.forEach((r,i)=>{r.rank=i>0&&r.points===entries[i-1].points&&r.firstLineAt===entries[i-1].firstLineAt?entries[i-1].rank:i+1;});
  return entries;
}
export async function handleWeeklyBingo(user,env,url,method,body,t=now()) {
  const key=method==='PUT' ? body?.week : url.searchParams.get('week')??nextEditableWeek(t);
  const requested=weekBounds(key),current=weekBounds(nextEditableWeek(t));
  if (!requested || requested[0]>current[0] || requested[0]<t-52*7*86400) return reply({error:"This week isn't available."},400);
  const week=await ensureWeek(env.DB,key,t);
  if (!week) return reply({error:'bad week'},400);
  if (method==='GET' && url.pathname==='/api/weekly-bingo') {
    const wallet=await ensureWallet(env.DB,user.id,t);
    return reply({week:key,startsAt:week.starts_at,endsAt:week.ends_at,locked:!!week.locked_at,ended:t>=week.ends_at,settled:!!week.settled_at,
      matches:week.matches,catalog:week.points,squares:WEEKLY_SQUARES,cards:await cards(env.DB,user.id,key),
      rules:{...BINGO,maxCards:week.paid_enabled?BINGO.maxCards:1,paidEnabled:!!week.paid_enabled},balance:wallet.balance});
  }
  if (method==='GET' && url.pathname==='/api/weekly-bingo/score') return reply({week:key,...await scored(env.DB,user.id,week,t)});
  if (method==='GET' && url.pathname==='/api/weekly-bingo/leaderboard') {
    const entries=await board(env.DB,week,t);
    const own=entries.find(x=>x.userId===user.id);
    return reply({week:key,entries:entries.slice(0,50).map(({username,points,rank})=>({username,points,rank})),me:{username:user.username,points:own?.points??0,rank:own?.rank??null}});
  }
  if (method!=='PUT'||url.pathname!=='/api/weekly-bingo') return reply({error:'method not allowed'},405);
  if (t>=week.ends_at) return reply({error:'This week is over, so cards are closed.'},409);
  if (key!==nextEditableWeek(t)) return reply({error:'You can only lock cards for this week.'},400);
  const {slot,cells,version}=body??{};
  if (!Number.isInteger(slot)||slot<1||slot>(week.paid_enabled?BINGO.maxCards:1)||!Number.isInteger(version)||version<0) return reply({error:'bad card'},400);
  const mine=await cards(env.DB,user.id,key);
  const old=mine.find(c=>c.slot===slot);
  if ((old?.version??0)!==version) return reply({error:'This card changed in another tab or device. Reload to see it.',card:old??{slot,cells:null,version:0}},409);
  if (old) return reply({error:"This card is locked, so it can't change."},409);
  if (!old&&slot!==mine.length+1) return reply({error:'Fill your cards in order, starting with card 1.'},400);
  const clean=Array.isArray(cells)?cells.map(c=>({square:c?.square,matchId:c?.matchId??null})):cells;
  const eligible=week.matches.filter(m=>m.startsAt>=t+MATCH_LEAD_TIME);
  const problem=validateWeeklyCard(clean,mine.filter(c=>c.slot!==slot),eligible,week.points);
  if (problem) return reply({error:problem},400);
  if (slot===1) {
    const res=await env.DB.prepare('INSERT INTO weekly_bingo_cards(user_id,week,slot,cells,version,updated_at,locked_at,catalog) VALUES(?,?,?,?,1,?,?,?) ON CONFLICT DO NOTHING')
      .bind(user.id,key,slot,JSON.stringify(clean),t,t,JSON.stringify(week.points)).run();
    return res.meta.changes?reply({ok:true,slot,version:1}):reply({error:'This card changed in another tab or device. Reload to see it.'},409);
  }
  // Paid cards stay disabled until the calibration gate sets paid_enabled on a future week.
  const wallet=await ensureWallet(env.DB,user.id,t);
  if (wallet.balance<BINGO.cardCost) return reply({error:"You don't have enough credits for this."},402);
  const keyOf=`bingo:${key}:${slot}`;
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO wallet_entries(user_id,entry_key,amount,balance_after,created_at)
        SELECT user_id,?,-?,balance-?,? FROM wallets WHERE user_id=? AND balance>=?`).bind(keyOf,BINGO.cardCost,BINGO.cardCost,t,user.id,BINGO.cardCost),
      env.DB.prepare(`UPDATE wallets SET balance=(SELECT balance_after FROM wallet_entries WHERE user_id=? AND entry_key=?)
        WHERE user_id=? AND changes()=1`).bind(user.id,keyOf,user.id),
      env.DB.prepare(`INSERT INTO weekly_bingo_cards(user_id,week,slot,cells,version,updated_at,locked_at,catalog)
        SELECT ?,?,?,?,1,?,?,? WHERE EXISTS(SELECT 1 FROM wallet_entries WHERE user_id=? AND entry_key=?)`)
        .bind(user.id,key,slot,JSON.stringify(clean),t,t,JSON.stringify(week.points),user.id,keyOf),
    ]);
  } catch { return reply({error:"That didn't go through because your cards changed. Reload and try again."},409); }
  const purchased=await env.DB.prepare('SELECT version FROM weekly_bingo_cards WHERE user_id=? AND week=? AND slot=?').bind(user.id,key,slot).first();
  if (!purchased) return reply({error:"You don't have enough credits for this."},402);
  const fresh=await env.DB.prepare('SELECT balance FROM wallets WHERE user_id=?').bind(user.id).first();
  return reply({ok:true,slot,version:1,balance:fresh.balance});
}

export async function settleWeeklyBingo(env,t=now()) {
  const weeks=(await env.DB.prepare('SELECT week FROM weekly_bingo_weeks WHERE ends_at<=? AND settled_at IS NULL').bind(t).all()).results;
  let count=0;
  for (const {week:key} of weeks) {
    const week=await ensureWeek(env.DB,key,t);
    const ctx=await weeklyContext(env.DB,week,t);
    if (!ctx.rosterComplete||Object.values(ctx.results).some(r=>r.state==='pending')) continue;
    const rows=(await env.DB.prepare('SELECT user_id,slot,cells,catalog,locked_at,updated_at FROM weekly_bingo_cards WHERE week=?').bind(key).all()).results;
    for (const row of rows) {
      const result=scoreWeeklyCard(JSON.parse(row.cells),week.matches,ctx.results,ctx.rosterEvents,row.catalog?JSON.parse(row.catalog):week.points,true,row.locked_at??row.updated_at,true);
      if (!result.complete) continue;
      const credits=Math.floor(result.total*week.payout_rate);
      await ensureWallet(env.DB,row.user_id,t);
      const entryKey=`bingo-award:${key}:${row.slot}`;
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO wallet_entries(user_id,entry_key,amount,balance_after,created_at)
          SELECT user_id,?,?,balance+?,? FROM wallets WHERE user_id=? ON CONFLICT DO NOTHING`).bind(entryKey,credits,credits,t,row.user_id),
        env.DB.prepare(`UPDATE wallets SET balance=(SELECT balance_after FROM wallet_entries WHERE user_id=? AND entry_key=?)
          WHERE user_id=? AND changes()=1 AND balance=(SELECT balance_after-amount FROM wallet_entries WHERE user_id=? AND entry_key=?)`)
          .bind(row.user_id,entryKey,row.user_id,row.user_id,entryKey),
        env.DB.prepare(`INSERT INTO weekly_bingo_results(user_id,week,slot,points,credits,detail,settled_at)
          VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`).bind(row.user_id,key,row.slot,result.total,credits,JSON.stringify(result),t),
      ]);
      count++;
    }
    const observed=[];
    for (const square of WEEKLY_SQUARES) {
      if(square.scope==='roster') {
        observed.push([key,square.id,-1,rosterEvidence(square.id,ctx.rosterEvents)?1:0,1]);
        continue;
      }
      const scope=week.matches.filter(m=>!square.bestOf||m.bestOf===square.bestOf);
      const eligible=scope.filter(m=>ctx.results[m.matchId]?.state==='final');
      const hits=eligible.filter(m=>matchHit(square.id,ctx.results[m.matchId])).length;
      observed.push([key,square.id,0,hits,eligible.length]);
      if(scope.length && eligible.length) observed.push([key,square.id,scope.length,hits>0?1:0,1]);
    }
    await env.DB.batch(observed.map(([w,s,e,h,n])=>env.DB.prepare(`INSERT INTO bingo_observations(week,square,exposure,hits,trials)
      VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING`).bind(w,s,e,h,n)));
    await env.DB.prepare('UPDATE weekly_bingo_weeks SET settled_at=? WHERE week=? AND settled_at IS NULL').bind(t,key).run();
  }
  return count;
}
