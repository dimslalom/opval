import cardArt from '../../../shared/src/data/cards.json' with { type: 'json' };
import { buyPack, resolveSeries, setCall, swapTracked } from '../../../src/engine/collect/game.js';
import { makeCardLookup } from '../../../src/engine/shared/cardLookup.js';
import { loadMatch } from '../../../worker/feed/routes.js';
import { ensureWallet } from './wallet.js';

const reply=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'private, no-store'}});
const now=()=>Math.floor(Date.now()/1000);
const safeState=s=>({ ...s, credits:Math.max(0,Math.floor(Number(s.credits)||0)) });
async function poolOf(db) {
  const lookup=makeCardLookup(cardArt);
  const players=(await db.prepare('SELECT vlr_id,handle,team_tag FROM feed_players').all()).results;
  const pool=[]; const byId=new Map();
  for (const p of players) {
    const card=lookup(p.handle,p.team_tag);
    if (card) pool.push({pid:p.vlr_id,tier:card.palette});
    byId.set(p.vlr_id,{team:p.team_tag,tier:card?.palette??'bronze'});
  }
  return {pool,byId};
}
export async function gameAction(user,env,body,t=now()) {
  const {op,version,requestId}=body??{};
  if (!Number.isInteger(version)||version<1||typeof requestId!=='string'||!/^[-\w]{8,80}$/.test(requestId)) return reply({error:'bad action'},400);
  const row=await env.DB.prepare('SELECT state,version FROM saves WHERE user_id=?').bind(user.id).first();
  if (!row||row.version!==version) return reply({error:'Game changed elsewhere',state:row?JSON.parse(row.state):null,version:row?.version??0},409);
  const wallet=await ensureWallet(env.DB,user.id,t);
  const old=safeState({...JSON.parse(row.state),credits:wallet.balance});
  const {pool,byId}=await poolOf(env.DB);
  let next,extra={};
  try {
    if (op==='pack') {
      const outcome=buyPack(old,pool,t);
      next=outcome.state;extra={cards:outcome.cards,refund:outcome.refund};
    } else if (op==='swap') {
      const out=Number(body.outPid),inside=Number(body.inPid);
      if (!Number.isSafeInteger(out)||!Number.isSafeInteger(inside)) throw new Error('bad player');
      next=swapTracked(old,out,inside,pid=>byId.get(pid)?.tier??'bronze',t);
    } else if (op==='call') {
      const id=Number(body.matchId);
      if (!Number.isSafeInteger(id)) throw new Error('bad match');
      const match=await env.DB.prepare('SELECT status,starts_at,team1_tag,team2_tag,best_of FROM feed_matches WHERE match_id=?').bind(id).first();
      if (!match||match.status!=='upcoming'||match.starts_at<=t) throw new Error('Match is locked');
      const choice=body.call;
      if (!choice||![match.team1_tag,match.team2_tag].includes(choice.winner)) throw new Error('bad winner');
      if (choice.score!=null&&(!Array.isArray(choice.score)||choice.score.length!==2||!choice.score.every(n=>Number.isInteger(n)&&n>=0&&n<=3))) throw new Error('bad score');
      if (choice.star!=null&&(!Number.isSafeInteger(choice.star)||!byId.has(choice.star))) throw new Error('bad star');
      next=setCall(old,id,{winner:choice.winner,score:choice.score??null,star:choice.star??null});
    } else if (op==='reveal') {
      const id=Number(body.matchId);
      if (!Number.isSafeInteger(id)) throw new Error('bad match');
      const series=await loadMatch(env,id);
      if (!series||series.status!=='final'||series.statsRank<3) throw new Error('Result is not ready');
      const outcome=resolveSeries(old,series,{teamOf:pid=>byId.get(pid)?.team??null});
      next=outcome.state;extra={report:outcome.report};
    } else return reply({error:'unknown action'},400);
  } catch(e) {return reply({error:e.message},400);}
  const delta=next.credits-old.credits;
  const entryKey=`game:${requestId}`;
  const saveJson=JSON.stringify(next);
  try {
    const steps=[env.DB.prepare(`UPDATE saves SET state=?,version=version+1,updated_at=? WHERE user_id=? AND version=?
      AND (SELECT balance FROM wallets WHERE user_id=?) + ? >= 0`).bind(saveJson,t,user.id,version,user.id,delta)];
    if (delta!==0) steps.push(
      env.DB.prepare(`INSERT INTO wallet_entries(user_id,entry_key,amount,balance_after,created_at)
        SELECT user_id,?,?,balance+?,? FROM wallets WHERE user_id=? AND changes()=1`).bind(entryKey,delta,delta,t,user.id),
      env.DB.prepare(`UPDATE wallets SET balance=(SELECT balance_after FROM wallet_entries WHERE user_id=? AND entry_key=?)
        WHERE user_id=? AND balance=(SELECT balance_after-amount FROM wallet_entries WHERE user_id=? AND entry_key=?)`)
        .bind(user.id,entryKey,user.id,user.id,entryKey),
    );
    const results=await env.DB.batch(steps);
    if (results?.[0]?.meta?.changes===0) return reply({error:'Game changed elsewhere'},409);
  } catch {return reply({error:'Action conflicted; reload your game'},409);}
  return reply({ok:true,state:next,version:version+1,...extra});
}
