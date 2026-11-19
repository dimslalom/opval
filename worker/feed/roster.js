const GCD_URL='https://competitiveops.riotgames.com/en-US/VALORANT';
const VLR_URL='https://www.vlr.gg/transfers';
const norm=s=>String(s??'').trim().replace(/\s+/g,' ');
const key=s=>norm(s).toLocaleLowerCase('en-US');
const now=()=>Math.floor(Date.now()/1000);
const reply=(x,status=200)=>Response.json(x,{status,headers:{'Cache-Control':'public, max-age=60'}});

export async function ingestTransfers(db,body,t=now()) {
  if (!Array.isArray(body.transfers)||body.transfers.length>500) throw new Error('bad transfers');
  const valid=[];
  for (const item of body.transfers) {
    const day=norm(item.day), vlrId=Number(item.vlrId), handle=norm(item.handle);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isSafeInteger(vlrId)||vlrId<=0||!handle||!Array.isArray(item.moves)) continue;
    const moves=JSON.stringify(item.moves);
    const txnKey=`${day}:${vlrId}:${moves}`;
    const sourceUrl=typeof item.sourceUrl==='string'&&item.sourceUrl.startsWith('https://www.vlr.gg/')?item.sourceUrl:VLR_URL;
    valid.push({txnKey,day,vlrId,handle,country:norm(item.country)||null,moves,sourceUrl});
  }
  if (!valid.length) return {accepted:0};
  const res=await db.prepare(`INSERT INTO feed_transfers(txn_key,day,vlr_id,handle,country,moves,seen_at,source_url)
    SELECT json_extract(value,'$.txnKey'),json_extract(value,'$.day'),json_extract(value,'$.vlrId'),
      json_extract(value,'$.handle'),json_extract(value,'$.country'),json_extract(value,'$.moves'),?,
      json_extract(value,'$.sourceUrl') FROM json_each(?) WHERE true ON CONFLICT DO NOTHING`)
    .bind(t,JSON.stringify(valid)).run();
  return {accepted:res.meta.changes};
}
const rowOf=r=>({player:norm(r.player),team:norm(r.team),league:norm(r.league),contractEnd:norm(r.contractEnd)||null});
// The weekly game only ever scored active players. The feed now also sends coaches and reserves
// (for the evidence model), so they are dropped here before any snapshot or event is made.
// Rows from an older feed carry no role/status at all and were already filtered; a blank sent value
// fails, as it did in the old parser.
const legacyRow=r=>(r.role===undefined||['player','active player'].includes(key(r.role)))&&(r.status===undefined||key(r.status)==='active');
export async function ingestContracts(db,body,t=now()) {
  if (!Array.isArray(body.contracts)||!body.contracts.length||body.contracts.length>5000) throw new Error('bad contracts');
  const contracts=body.contracts.filter(legacyRow);
  if (!contracts.length) throw new Error('bad contracts');
  const input=new Map(),ambiguous=[];
  for (const raw of contracts) {
    const row=rowOf(raw);
    if (!row.player||!row.team||!row.league) {ambiguous.push({key:'missing',row:raw});continue;}
    const id=`${key(row.player)}|${key(row.league)}`;
    if (input.has(id)) ambiguous.push({key:id,row:raw});
    else input.set(id,row);
  }
  for (const a of ambiguous) input.delete(a.key);
  if (input.size===0) throw new Error('no unambiguous contract rows');
  const canonical=JSON.stringify([...input].sort((a,b)=>a[0].localeCompare(b[0])));
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical)))).map(x=>x.toString(16).padStart(2,'0')).join('');
  await db.prepare('INSERT INTO roster_snapshots(source,content_hash,observed_at,row_count) VALUES(?,?,?,?) ON CONFLICT DO NOTHING')
    .bind('riot-gcd',hash,t,input.size).run();
  const snapshot=await db.prepare('SELECT id FROM roster_snapshots WHERE source=? AND content_hash=?').bind('riot-gcd',hash).first();
  const packed=JSON.stringify([...input].map(([id,r])=>({id,...r})));
  await db.prepare(`INSERT INTO roster_snapshot_rows(snapshot_id,identity_key,player,team,league,contract_end)
    SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.player'),json_extract(value,'$.team'),
      json_extract(value,'$.league'),json_extract(value,'$.contractEnd') FROM json_each(?) WHERE true
    ON CONFLICT DO NOTHING`).bind(snapshot.id,packed).run();
  await db.prepare('INSERT INTO roster_source_checks(observed_at,snapshot_id) VALUES(?,?) ON CONFLICT DO NOTHING').bind(t,snapshot.id).run();
  for (const a of ambiguous) await db.prepare(`INSERT INTO roster_unresolved(identity_key,reason,raw_row,observed_at) VALUES(?,?,?,?)
    ON CONFLICT(identity_key) DO UPDATE SET reason=excluded.reason,raw_row=excluded.raw_row,observed_at=excluded.observed_at`)
    .bind(a.key==='missing'?`missing:${JSON.stringify(a.row).slice(0,80)}`:a.key,'Ambiguous or missing player identity',JSON.stringify(a.row),t).run();
  await db.prepare(`DELETE FROM roster_unresolved WHERE identity_key IN
    (SELECT json_extract(value,'$.id') FROM json_each(?))`).bind(packed).run();
  const existing=(await db.prepare('SELECT * FROM roster_contracts').all()).results;
  if (!existing.length) {
    await db.prepare(`INSERT INTO roster_contracts(identity_key,player,team,league,contract_end,source_url,updated_at)
      SELECT json_extract(value,'$.id'),json_extract(value,'$.player'),json_extract(value,'$.team'),
        json_extract(value,'$.league'),json_extract(value,'$.contractEnd'),?,? FROM json_each(?) WHERE true
      ON CONFLICT DO NOTHING`).bind(GCD_URL,t,packed).run();
    return {baseline:true,rows:input.size,unresolved:ambiguous.length,events:0};
  }
  const known=new Map(existing.map(r=>[r.identity_key,{player:r.player,team:r.team,league:r.league,contractEnd:r.contract_end}]));
  const candidates=[];
  for (const [id,next] of input) {
    const prev=known.get(id);
    if (!prev) candidates.push([id,'roster_add',null,next]);
    else {
      if (prev.team!==next.team) {
        candidates.push([id,'roster_depart',prev,next]);
        candidates.push([id,'roster_add',prev,next]);
      }
      if (prev.contractEnd!==next.contractEnd) candidates.push([id,'contract_change',prev,next]);
    }
  }
  for (const [id,prev] of known) if (!input.has(id)&&!ambiguous.some(a=>a.key===id)) candidates.push([id,'roster_depart',prev,null]);
  let events=0;
  const active=new Set();
  for (const [id,type,oldRow,newRow] of candidates) {
    const candidateKey=`${id}:${type}`;
    active.add(candidateKey);
    const oldJson=oldRow?JSON.stringify(oldRow):null, newJson=newRow?JSON.stringify(newRow):null;
    const prior=await db.prepare('SELECT * FROM roster_candidates WHERE identity_key=?').bind(candidateKey).first();
    const same=prior&&prior.old_row===oldJson&&prior.new_row===newJson;
    const firstSeen=same?prior.first_seen_at:t;
    const passes=same?prior.passes+1:1;
    await db.prepare(`INSERT INTO roster_candidates(identity_key,change_type,old_row,new_row,first_seen_at,passes) VALUES(?,?,?,?,?,?)
      ON CONFLICT(identity_key) DO UPDATE SET old_row=excluded.old_row,new_row=excluded.new_row,first_seen_at=excluded.first_seen_at,passes=excluded.passes`)
      .bind(candidateKey,type,oldJson,newJson,firstSeen,passes).run();
    if (passes<2) continue;
    const current=newRow??oldRow;
    await db.prepare(`INSERT INTO roster_events(identity_key,change_type,player,team,old_end,new_end,source_url,first_seen_at,confirmed_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`)
      .bind(id,type,current.player,current.team,oldRow?.contractEnd??null,newRow?.contractEnd??null,GCD_URL,firstSeen,t).run();
    if (type==='roster_depart'&&!newRow) await db.prepare('DELETE FROM roster_contracts WHERE identity_key=?').bind(id).run();
    else if (newRow) await db.prepare(`INSERT INTO roster_contracts(identity_key,player,team,league,contract_end,source_url,updated_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(identity_key) DO UPDATE SET player=excluded.player,team=excluded.team,league=excluded.league,contract_end=excluded.contract_end,updated_at=excluded.updated_at`)
      .bind(id,newRow.player,newRow.team,newRow.league,newRow.contractEnd,GCD_URL,t).run();
    await db.prepare('DELETE FROM roster_candidates WHERE identity_key=?').bind(candidateKey).run();
    events++;
  }
  for (const r of (await db.prepare('SELECT identity_key FROM roster_candidates').all()).results) {
    if (!active.has(r.identity_key)) await db.prepare('DELETE FROM roster_candidates WHERE identity_key=?').bind(r.identity_key).run();
  }
  return {baseline:false,rows:input.size,unresolved:ambiguous.length,events};
}
export async function getRoster(db,path) {
  if (path==='/api/roster/transfers') {
    const rows=(await db.prepare('SELECT day,vlr_id AS vlrId,handle,moves,seen_at AS seenAt,source_url AS sourceUrl FROM feed_transfers ORDER BY day DESC,seen_at DESC LIMIT 300').all()).results;
    return reply({transfers:rows.map(r=>({...r,moves:JSON.parse(r.moves)}))});
  }
  if (path==='/api/roster/contracts') {
    const rows=(await db.prepare('SELECT player,team,league,contract_end AS contractEnd,source_url AS sourceUrl,updated_at AS updatedAt FROM roster_contracts ORDER BY team,player LIMIT 3000').all()).results;
    return reply({contracts:rows});
  }
  if (path==='/api/roster/snapshots') {
    const rows=(await db.prepare(`SELECT s.id,s.observed_at AS observedAt,s.row_count AS rowCount,
      (SELECT MAX(c.observed_at) FROM roster_source_checks c WHERE c.snapshot_id=s.id) AS lastSeenAt
      FROM roster_snapshots s ORDER BY s.observed_at DESC LIMIT 50`).all()).results;
    return reply({snapshots:rows,sourceUrl:GCD_URL});
  }
  const snapshotId=path.match(/^\/api\/roster\/snapshots\/(\d+)$/);
  if (snapshotId) {
    const rows=(await db.prepare(`SELECT player,team,league,contract_end AS contractEnd FROM roster_snapshot_rows
      WHERE snapshot_id=? ORDER BY league,team,player`).bind(Number(snapshotId[1])).all()).results;
    return reply({snapshotId:Number(snapshotId[1]),contracts:rows,sourceUrl:GCD_URL});
  }
  if (path==='/api/roster/events') {
    const rows=(await db.prepare(`SELECT change_type AS changeType,player,team,old_end AS oldEnd,new_end AS newEnd,source_url AS sourceUrl,
      first_seen_at AS firstSeenAt,confirmed_at AS confirmedAt FROM roster_events ORDER BY first_seen_at DESC LIMIT 300`).all()).results;
    return reply({events:rows});
  }
  if (path==='/api/roster/status') {
    const checks=(await db.prepare('SELECT MAX(observed_at) AS lastReadAt FROM roster_source_checks').first());
    const unresolved=(await db.prepare('SELECT COUNT(*) AS n FROM roster_unresolved').first()).n;
    const transfer=(await db.prepare("SELECT last_success_at AS lastReadAt,last_error AS lastError FROM feed_sources WHERE source='transfers'").first()) ?? {lastReadAt:null,lastError:null};
    const official=(await db.prepare("SELECT last_error AS lastError FROM feed_sources WHERE source='contracts'").first()) ?? {lastError:null};
    return reply({riot:{sourceUrl:GCD_URL,lastReadAt:checks.lastReadAt,lastError:official.lastError,stale:!checks.lastReadAt||now()-checks.lastReadAt>3*3600,unresolved},vlr:{sourceUrl:VLR_URL,lastReadAt:transfer.lastReadAt,lastError:transfer.lastError}});
  }
  if (path==='/api/roster/unresolved') {
    const rows=(await db.prepare('SELECT identity_key AS identityKey,reason,observed_at AS observedAt FROM roster_unresolved ORDER BY observed_at DESC LIMIT 100').all()).results;
    return reply({unresolved:rows});
  }
  return reply({error:'not found'},404);
}
