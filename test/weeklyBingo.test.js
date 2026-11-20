import test from 'node:test';
import assert from 'node:assert/strict';
import { d1 } from './helpers/d1Shim.js';
import { weekKey, weekBounds, nextEditableWeek, weeklyCatalog, validateWeeklyCard, scoreWeeklyCard } from '../apps/call/src/lib/weeklyBingo.js';
import { ingestContracts, ingestTransfers, getRoster } from '../worker/feed/roster.js';
import { handleWeeklyBingo } from '../apps/call/worker/weeklyBingo.js';
import { ensureWallet, postWallet } from '../apps/call/worker/wallet.js';

const monday=Date.parse('2026-10-05T00:00:00Z')/1000;
const sq=(square,matchId=null)=>({square,matchId});
test('UTC week boundaries and current-week submission window',()=>{
  assert.equal(weekKey(monday-1),'2026-09-28');
  assert.equal(weekKey(monday),'2026-10-05');
  assert.deepEqual(weekBounds('2026-10-05'),[monday,monday+604800]);
  assert.equal(weekBounds('2026-10-06'),null);
  assert.equal(nextEditableWeek(monday-1),'2026-09-28');
  assert.equal(nextEditableWeek(monday),'2026-10-05');
});
test('unique events across cards; named match must be frozen schedule member',()=>{
  const matches=[{matchId:3,bestOf:3}],catalog=weeklyCatalog(1);
  const a=[sq('ace'),sq('ot',3),sq('roster_add'),sq('contract_change')];
  assert.equal(validateWeeklyCard(a,[],matches,catalog),null);
  assert.match(validateWeeklyCard([sq('ace'),sq('k30'),sq('c3'),sq('c4')],[{cells:a}],matches,catalog),/Duplicate/);
  assert.match(validateWeeklyCard([sq('ace',99),sq('k30'),sq('c3'),sq('c4')],[],matches,catalog),/not on/);
});
test('weekly general hits any scheduled match; named void is neutral',()=>{
  const matches=[{matchId:1,bestOf:3},{matchId:2,bestOf:3}];
  const results={1:{state:'final',finalAt:10,maps:[{score1:13,score2:12,players:[]}]},2:{state:'void'}};
  const cells=[sq('ot'),sq('ace',2),sq('roster_add'),sq('contract_change')];
  const score=scoreWeeklyCard(cells,matches,results,[{changeType:'roster_add',firstSeenAt:11,player:'A',team:'B',sourceUrl:'https://example.test'}],weeklyCatalog(2),true);
  assert.deepEqual(score.cells.map(x=>x.state),['hit','free','hit','miss']);
  assert.equal(score.complete,true);
  assert.equal(score.cells[0].evidence.matchId,1);
});
test('a midweek card cannot score earlier results or earlier roster observations',()=>{
  const schedule=[{matchId:1,bestOf:3,startsAt:monday+3600},{matchId:2,bestOf:3,startsAt:monday+3*3600}];
  const result={state:'final',finalAt:monday+4*3600,maps:[{score1:13,score2:12,players:[]}]};
  const cells=[sq('ot'),sq('roster_add'),sq('contract_change'),sq('roster_depart')];
  const events=[{changeType:'roster_add',firstSeenAt:monday+1800,player:'A',team:'B',sourceUrl:'https://example.test'}];
  const before=scoreWeeklyCard(cells,schedule,{1:result,2:{state:'pending'}},events,weeklyCatalog(schedule),false,monday+2*3600,false);
  assert.equal(before.cells[0].state,'pending','earlier finished match is ineligible');
  assert.equal(before.cells[1].state,'pending','earlier official observation is ineligible');
  const after=scoreWeeklyCard(cells,schedule,{1:result,2:result},[...events,{...events[0],firstSeenAt:monday+3*3600}],weeklyCatalog(schedule),true,monday+2*3600,true);
  assert.equal(after.cells[0].evidence.matchId,2);
  assert.equal(after.cells[1].evidence.observedAt,monday+3*3600);
});
test('general match picks work while the published slate is empty',async()=>{
  const db=d1(),env={DB:db},user={id:1,username:'alpha'};
  db.sqlite.prepare("INSERT INTO users(id,username,pw_hash,created_at) VALUES(1,'alpha','x',0)").run();
  const week='2026-10-05',url=new URL('https://x.test/api/weekly-bingo');
  const chosen=[sq('ot'),sq('ace'),sq('roster_add'),sq('contract_change')];
  assert.equal((await handleWeeklyBingo(user,env,url,'PUT',{week,slot:1,version:0,cells:chosen},monday+60)).status,200);
  const early=scoreWeeklyCard(chosen,[],{},[],weeklyCatalog([]),false,monday+60,false);
  assert.equal(early.cells[0].state,'pending');
  const tooLate=await handleWeeklyBingo({id:2,username:'other'},env,url,'PUT',
    {week,slot:1,version:0,cells:[sq('ot',3),sq('ace'),sq('roster_add'),sq('contract_change')]},monday+60);
  assert.equal(tooLate.status,400,'named picks require a known eligible match');
});
test('roster-only cards work without matches and contract direction uses published dates',()=>{
  const cells=[sq('roster_add'),sq('roster_depart'),sq('contract_extend'),sq('multi_team_change')];
  assert.equal(validateWeeklyCard(cells,[],[],weeklyCatalog([])),null);
  const events=[
    {changeType:'contract_change',oldEnd:'June 30, 2027',newEnd:'June 30, 2028',firstSeenAt:10,player:'A',team:'One',sourceUrl:'https://example.test'},
    {changeType:'roster_add',firstSeenAt:11,player:'B',team:'Two',sourceUrl:'https://example.test'},
  ];
  const score=scoreWeeklyCard(cells,[],{},events,weeklyCatalog([]),true);
  assert.deepEqual(score.cells.map(x=>x.state),['hit','miss','hit','hit']);
  const china=scoreWeeklyCard([sq('contract_extend'),sq('contract_shorten'),sq('roster_add'),sq('roster_depart')],[],{},[
    {changeType:'contract_change',oldEnd:'2027 Season End',newEnd:'2028 Season End',firstSeenAt:12,player:'C',team:'CN',sourceUrl:'https://example.test'},
  ],weeklyCatalog([]),true);
  assert.equal(china.cells[0].state,'hit');
  assert.equal(china.cells[1].state,'miss');
});
test('Riot snapshot baseline, two-read confirmation and ambiguous identity exclusion',async()=>{
  const db=d1();
  const base=[{player:'Alpha',team:'A',league:'Americas',contractEnd:'2027'}];
  assert.equal((await ingestContracts(db,{contracts:base},100)).baseline,true);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM roster_snapshot_rows').first()).n,1);
  const snapshots=await (await getRoster(db,'/api/roster/snapshots')).json();
  assert.equal(snapshots.snapshots.length,1);
  const snapshot=await (await getRoster(db,`/api/roster/snapshots/${snapshots.snapshots[0].id}`)).json();
  assert.equal(snapshot.contracts[0].player,'Alpha');
  assert.equal((await ingestContracts(db,{contracts:[{...base[0],contractEnd:'2028'}]},200)).events,0);
  assert.equal((await ingestContracts(db,{contracts:[{...base[0],contractEnd:'2028'}]},300)).events,1);
  const events=(await db.prepare('SELECT * FROM roster_events').all()).results;
  assert.equal(events[0].change_type,'contract_change');
  assert.equal(events[0].first_seen_at,200);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM roster_snapshot_rows').first()).n,2);
  await ingestContracts(db,{contracts:[{player:'Beta',team:'B',league:'Americas',contractEnd:'2027'},{player:'Beta',team:'C',league:'Americas',contractEnd:'2027'},base[0]]},400);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM roster_unresolved').first()).n,1);
  await ingestContracts(db,{contracts:[{player:'Beta',team:'B',league:'Americas',contractEnd:'2027'},base[0]]},500);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM roster_unresolved').first()).n,0);
});
test('VLR log is readable but never itself a ranked roster event',async()=>{
  const db=d1();
  await ingestTransfers(db,{transfers:[{day:'2026-10-05',vlrId:10,handle:'Alpha',moves:[{type:'joined',team:'A'}],sourceUrl:'https://www.vlr.gg/player/10'}]},100);
  const got=await (await getRoster(db,'/api/roster/transfers')).json();
  assert.equal(got.transfers.length,1);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM roster_events').first()).n,0);
});
test('a confirmed team move can also confirm a contract end change',async()=>{
  const db=d1(),base={player:'Alpha',team:'One',league:'AMERICAS',contractEnd:'June 30, 2027'};
  await ingestContracts(db,{contracts:[base]},100);
  const changed={...base,team:'Two',contractEnd:'June 30, 2028'};
  assert.equal((await ingestContracts(db,{contracts:[changed]},200)).events,0);
  assert.equal((await ingestContracts(db,{contracts:[changed]},300)).events,3);
  const types=(await db.prepare('SELECT change_type FROM roster_events ORDER BY change_type').all()).results.map(r=>r.change_type);
  assert.deepEqual(types,['contract_change','roster_add','roster_depart']);
});
test('an interrupted first snapshot resumes as a baseline without fake events',async()=>{
  const db=d1(),rows=Array.from({length:40},(_,i)=>({player:`Player${i}`,team:`Team${i}`,league:'AMERICAS',contractEnd:'2027'}));
  await ingestContracts(db,{contracts:rows},100);
  db.sqlite.exec('DELETE FROM roster_contracts');
  db.sqlite.exec("DELETE FROM roster_snapshot_rows WHERE identity_key != 'player0|americas'");
  const retry=await ingestContracts(db,{contracts:rows},200);
  assert.equal(retry.baseline,true);
  assert.equal(retry.events,0);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM roster_snapshot_rows').first()).n,40);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM roster_contracts').first()).n,40);
});
test('current-week card locks on submission and later listed matches can score',async()=>{
  const db=d1(),env={DB:db},user={id:1,username:'alpha'};
  db.sqlite.prepare("INSERT INTO users(id,username,pw_hash,created_at) VALUES(1,'alpha','x',0)").run();
  db.sqlite.prepare('INSERT INTO saves(user_id,state,updated_at,version) VALUES(1,?,0,1)').run(JSON.stringify({credits:120,collection:[]}));
  const wallet=await ensureWallet(db,1,100);
  assert.equal(wallet.balance,120);
  assert.equal((await postWallet(db,1,'pack-1',-100,101)).balance_after,20);
  assert.equal((await postWallet(db,1,'pack-1',-100,102)).balance_after,20);
  assert.equal((await ensureWallet(db,1,103)).balance,20);
  const week='2026-10-05';
  db.sqlite.prepare(`INSERT INTO feed_matches(match_id,event_id,best_of,starts_at,status,updated_at)
    VALUES(9,1,3,?,'upcoming',0)`).run(monday+7200);
  const get=async t=>handleWeeklyBingo(user,env,new URL(`https://x.test/api/weekly-bingo?week=${week}`),'GET',null,t);
  assert.equal((await (await get(monday+10)).json()).locked,false);
  const put=await handleWeeklyBingo(user,env,new URL('https://x.test/api/weekly-bingo'),'PUT',
    {week,slot:1,version:0,cells:[sq('ace'),sq('ot',9),sq('roster_add'),sq('contract_change')]},monday+10);
  assert.equal(put.status,200);
  const frozenCatalog=JSON.parse(db.sqlite.prepare('SELECT catalog FROM weekly_bingo_cards WHERE user_id=1 AND week=?').get(week).catalog);
  db.sqlite.prepare(`INSERT INTO feed_matches(match_id,event_id,best_of,starts_at,status,updated_at,first_seen_at)
    VALUES(10,1,3,?,'upcoming',?,?)`).run(monday+10800,monday+20,monday+20);
  const current=await (await get(monday+30)).json();
  assert.equal(current.locked,false);
  assert.deepEqual(current.matches.map(m=>m.matchId),[9,10],'a newly listed match joins the current week');
  assert.equal(current.cards[0].locked_at,monday+10);
  assert.deepEqual(current.cards[0].catalog,frozenCatalog,'the submitted card keeps its original point values');
  const late=await handleWeeklyBingo(user,env,new URL('https://x.test/api/weekly-bingo'),'PUT',
    {week,slot:1,version:1,cells:[sq('ace'),sq('ot',10),sq('roster_add'),sq('contract_change')]},monday+30);
  assert.equal(late.status,409);
  assert.match((await late.json()).error,/locked/);
  db.sqlite.prepare(`INSERT INTO feed_matches(match_id,event_id,best_of,starts_at,status,updated_at,first_seen_at)
    VALUES(11,1,3,?,'final',?,?)`).run(monday+1800,monday+30,monday+20);
  assert.deepEqual((await (await get(monday+40)).json()).matches.map(m=>m.matchId),[9,10],
    'a late listed already started match cannot enter the slate');
});

test('server call actions are validated and a replayed request is refused',async()=>{
  const {handleAccounts}=await import('../apps/call/worker/accounts.js');
  const db=d1(),env={DB:db};
  const req=(method,path,body,cookie)=>{
    const url=new URL(`https://x.test${path}`);
    return handleAccounts(new Request(url,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined}),env,url);
  };
  const signup=await req('POST','/api/auth/signup',{username:'secure_user',password:'correct horse'});
  const cookie=signup.headers.get('Set-Cookie').split(';')[0];
  const save=await (await req('GET','/api/save',null,cookie)).json();
  db.sqlite.prepare(`INSERT INTO feed_matches(match_id,event_id,best_of,starts_at,status,team1_tag,team2_tag,updated_at)
    VALUES(44,1,3,?,'upcoming','AAA','BBB',0)`).run(Math.floor(Date.now()/1000)+3600);
  const action=await req('POST','/api/game/action',{op:'call',version:save.version,requestId:'req-00000001',matchId:44,call:{winner:'AAA'}},cookie);
  assert.equal(action.status,200);
  assert.equal((await action.json()).state.calls[44].winner,'AAA');
  const replay=await req('POST','/api/game/action',{op:'call',version:save.version,requestId:'req-00000001',matchId:44,call:{winner:'AAA'}},cookie);
  assert.equal(replay.status,409);
});

test('complete historical week pays free card once; a source gap keeps settlement pending',async()=>{
  const {settleWeeklyBingo}=await import('../apps/call/worker/weeklyBingo.js');
  const db=d1(),env={DB:db},start=monday-7*86400,end=monday;
  db.sqlite.prepare("INSERT INTO users(id,username,pw_hash,created_at) VALUES(1,'alpha','x',0)").run();
  db.sqlite.prepare('INSERT INTO saves(user_id,state,updated_at,version) VALUES(1,?,0,1)').run(JSON.stringify({credits:0,collection:[]}));
  const week='2026-09-28',schedule=[{matchId:99,bestOf:3,startsAt:start+3600}];
  db.sqlite.prepare(`INSERT INTO feed_matches(match_id,event_id,best_of,starts_at,status,updated_at)
    VALUES(99,1,3,?,'upcoming',0)`).run(start+3600);
  db.sqlite.prepare(`INSERT INTO weekly_bingo_weeks(week,starts_at,ends_at,schedule,catalog,locked_at)
    VALUES(?,?,?,?,?,?)`).run(week,start,end,JSON.stringify(schedule),JSON.stringify(weeklyCatalog(schedule)),start);
  db.sqlite.prepare(`INSERT INTO weekly_bingo_cards(user_id,week,slot,cells,updated_at)
    VALUES(1,?,1,?,0)`).run(week,JSON.stringify([sq('roster_add'),sq('roster_depart'),sq('contract_change'),sq('ace')]));
  db.sqlite.prepare(`INSERT INTO roster_events(identity_key,change_type,player,team,source_url,first_seen_at,confirmed_at)
    VALUES('a','roster_add','Alpha','AAA','https://example.test',?,?)`).run(start+7200,start+10800);
  db.sqlite.prepare("INSERT INTO roster_snapshots(id,source,content_hash,observed_at,row_count) VALUES(1,'riot-gcd','h',?,1)").run(start-3600);
  const check=db.sqlite.prepare('INSERT INTO roster_source_checks(observed_at,snapshot_id) VALUES(?,1)');
  check.run(start-3600);check.run(end+3600);
  assert.equal(await settleWeeklyBingo(env,end+2*86400),0,'gap leaves week pending');
  for(let t=start+3600;t<end;t+=3600) check.run(t);
  assert.equal(await settleWeeklyBingo(env,end+2*86400),1);
  const balance=(await ensureWallet(db,1,end+2*86400)).balance;
  assert.ok(balance>0);
  assert.equal(await settleWeeklyBingo(env,end+2*86400),0);
  assert.equal((await ensureWallet(db,1,end+2*86400)).balance,balance);
});

test('paid-card debit and card creation are atomic; no duplicated event across cards',async()=>{
  const db=d1(),env={DB:db},user={id:1,username:'alpha'},week='2026-10-05';
  db.sqlite.prepare("INSERT INTO users(id,username,pw_hash,created_at) VALUES(1,'alpha','x',0)").run();
  db.sqlite.prepare('INSERT INTO saves(user_id,state,updated_at,version) VALUES(1,?,0,1)').run(JSON.stringify({credits:150,collection:[]}));
  db.sqlite.prepare(`INSERT INTO feed_matches(match_id,event_id,best_of,starts_at,status,updated_at)
    VALUES(9,1,3,?,'upcoming',0)`).run(monday+7200);
  const url=new URL('https://x.test/api/weekly-bingo');
  const put=(slot,cells)=>handleWeeklyBingo(user,env,url,'PUT',{week,slot,version:0,cells},monday+10);
  assert.equal((await put(1,[sq('ace'),sq('ot'),sq('roster_add'),sq('contract_change')])).status,200);
  db.sqlite.prepare('UPDATE weekly_bingo_weeks SET paid_enabled=1').run();
  assert.equal((await put(2,[sq('ace'),sq('k30'),sq('c3'),sq('c4')])).status,400);
  assert.equal((await put(2,[sq('k30'),sq('c3'),sq('c4'),sq('roster_depart')])).status,200);
  assert.equal((await ensureWallet(db,1,monday-1)).balance,50);
  assert.equal((await put(3,[sq('short20'),sq('stomp8'),sq('fk8'),sq('yoruTop')])).status,402);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM weekly_bingo_cards WHERE user_id=1').first()).n,2);
  assert.equal((await ensureWallet(db,1,monday-1)).balance,50);
});

test('server pack action owns cards and credits, and a replay cannot mint a second refund',async()=>{
  const {handleAccounts}=await import('../apps/call/worker/accounts.js');
  const db=d1(),env={DB:db};
  const req=(method,path,body,cookie)=>{
    const url=new URL(`https://x.test${path}`);
    return handleAccounts(new Request(url,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined}),env,url);
  };
  const signup=await req('POST','/api/auth/signup',{username:'packer',password:'correct horse'});
  const cookie=signup.headers.get('Set-Cookie').split(';')[0];
  await req('GET','/api/save',null,cookie);
  db.sqlite.prepare("INSERT INTO feed_players(vlr_id,handle,team_tag,updated_at) VALUES(7,'crashies','FNC',0)").run();
  const action={op:'pack',version:1,requestId:'pack-action-7'};
  const first=await req('POST','/api/game/action',action,cookie);
  assert.equal(first.status,200);
  const body=await first.json();
  assert.deepEqual(body.cards,[7]);
  assert.equal(body.state.credits,400);
  assert.equal(body.state.collection[0],7);
  assert.equal((await req('POST','/api/game/action',action,cookie)).status,409);
  assert.equal((await (await req('GET','/api/save',null,cookie)).json()).state.credits,400);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM wallet_entries WHERE entry_key='game:pack-action-7'").first()).n,1);
});

test('paid rollout stays closed before sufficient settled weeks and valid replay',async()=>{
  const {calibratePaid}=await import('../apps/call/worker/calibration.js');
  const db=d1(),env={DB:db};
  assert.equal((await calibratePaid(env,monday)).ready,false);
  for(let i=1;i<=4;i++) {
    const start=monday-i*7*86400,key=weekKey(start);
    db.sqlite.prepare(`INSERT INTO weekly_bingo_weeks(week,starts_at,ends_at,schedule,catalog,locked_at,settled_at)
      VALUES(?,?,?,?,?,?,?)`).run(key,start,start+7*86400,'[]',JSON.stringify(weeklyCatalog([])),start,start+7*86400);
  }
  const result=await calibratePaid(env,monday+3600);
  assert.equal(result.ready,false);
  assert.equal((await db.prepare('SELECT passed FROM bingo_calibration ORDER BY id DESC LIMIT 1').first()).passed,0);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM weekly_bingo_weeks WHERE paid_enabled=1').first()).n,0);
});

test('server settles tracked players without a call and never pays twice',async()=>{
  const {readFileSync}=await import('node:fs');
  const {normalizeMatch}=await import('../scripts/feed/normalize.js');
  const {ingestMatches}=await import('../worker/feed/store.js');
  const {createCollection}=await import('../src/engine/collect/game.js');
  const {settleAll}=await import('../apps/call/worker/settle.js');
  const db=d1(),env={DB:db};
  const fixture=JSON.parse(readFileSync(new URL('./fixtures/feed/match-753462.v2.json',import.meta.url),'utf8'));
  const match=normalizeMatch(fixture.data.segments[0]);
  await ingestMatches(db,{matches:[match]});
  db.sqlite.prepare("INSERT INTO users(id,username,pw_hash,created_at) VALUES(1,'tracked_user','x',0)").run();
  const state=createCollection({seed:1,now:match.startsAt-3600});
  state.collection=[37489];state.tracked=[37489];state.trackedLog=[{t:0,tracked:[37489]}];
  db.sqlite.prepare('INSERT INTO saves(user_id,state,updated_at,version) VALUES(1,?,0,1)').run(JSON.stringify(state));
  assert.equal(await settleAll(env,match.startsAt+3*86400),1);
  const first=await ensureWallet(db,1,match.startsAt+3*86400);
  assert.ok(first.balance>0);
  assert.equal(await settleAll(env,match.startsAt+3*86400),0);
  assert.equal((await ensureWallet(db,1,match.startsAt+3*86400)).balance,first.balance);
  const saved=JSON.parse(db.sqlite.prepare('SELECT state FROM saves WHERE user_id=1').get().state);
  assert.equal(saved.revealed[match.matchId].unseen,true);
  assert.ok(saved.revealed[match.matchId].trackedPoints>0);
});

test('future catalog incorporates observed weekly and named-match hit rates',()=>{
  const slate=Array.from({length:3},(_,i)=>({matchId:i+1,bestOf:3}));
  const prior=weeklyCatalog(slate);
  const learned=weeklyCatalog(slate,[
    {square:'ace',exposure:0,hits:0,trials:100},
    {square:'ace',exposure:3,hits:0,trials:20},
  ]);
  assert.ok(learned.ace.named>prior.ace.named);
  assert.ok(learned.ace.general>prior.ace.general);
});
