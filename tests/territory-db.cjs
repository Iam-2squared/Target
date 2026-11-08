'use strict';
// Real PostgreSQL, real RPCs and synthetic identities in a newly-created
// loopback database only. Never connect this verifier to a hosted project.
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs/promises');
const path=require('node:path');
const {Client,Pool}=require('pg');
const {generateQuestions}=require('../server/questions.cjs');
const root=path.resolve(__dirname,'..');
const source=new URL(process.env.DATABASE_URL||'');
assert.equal(process.env.NODE_ENV,'test');
assert(['localhost','127.0.0.1','[::1]'].includes(source.hostname),'Only a dedicated loopback test database is allowed.');
const name='target_territory_backend_test';
const migration='20261108082752_target_territory_battle.sql';
const uuid=()=>crypto.randomUUID();
const secret=crypto.randomBytes(32).toString('base64url');
const person=name=>({memberId:uuid(),name});
const makeURL=name=>{const url=new URL(source);url.pathname='/'+name;return url.href;};
const db=new Pool({connectionString:makeURL(name),max:45,statement_timeout:25000});
let checks=0,phase='setup',passed=false;
const results=[];
const eq=(actual,expected,label)=>{checks++;assert.deepEqual(actual,expected,label);};
const ok=(value,label)=>{checks++;assert(value,label);};
async function scenario(label,fn){phase=label;const start=Date.now();await fn();results.push({name:label,status:'passed',durationMs:Date.now()-start});console.log('PASS '+label);}
async function fresh(){
  const admin=new Client({connectionString:makeURL('postgres')});
  await admin.connect();
  try{await admin.query('DROP DATABASE IF EXISTS '+name+' WITH (FORCE)');await admin.query('CREATE DATABASE '+name);}
  finally{await admin.end();}
  const directory=path.join(root,'supabase/migrations');
  for(const file of (await fs.readdir(directory)).filter(file=>file.endsWith('.sql')&&file<migration).sort())await db.query(await fs.readFile(path.join(directory,file),'utf8'));
  await db.query("INSERT INTO target_private.server_credentials(singleton,key_hash) VALUES(true,encode(sha256(convert_to($1,'UTF8')),'hex'))",[secret]);
}
async function seed(actor,total=10000000){await db.query('INSERT INTO target_private.profiles(member_id,name,total_points,correct_count,answered_count) VALUES($1,$2,$3::bigint,ceil($3::numeric/100000),ceil($3::numeric/100000))',[actor.memberId,actor.name,total]);}
const shop=(action,actor)=>db.query('SELECT public.target_shop_rpc($1,$2,$3::jsonb) AS value',[secret,action,JSON.stringify(actor)]).then(r=>r.rows[0].value);
const quiz=(action,actor)=>db.query('SELECT public.target_rpc($1,$2,$3::jsonb) AS value',[secret,action,JSON.stringify(actor)]).then(r=>r.rows[0].value);
const oldMap=(action,actor)=>db.query('SELECT public.target_map_rpc($1,$2,$3::jsonb) AS value',[secret,action,JSON.stringify(actor)]).then(r=>r.rows[0].value);
const draw=actor=>shop('draw',{...actor,requestId:uuid(),expectedPrice:100000,expectedCatalogVersion:3,itemType:'sticker'});
async function fingerprint(){return(await db.query("SELECT p.oid::regprocedure::text AS signature,md5(pg_get_functiondef(p.oid)) AS hash FROM pg_proc p WHERE p.oid IN ('public.target_rpc(text,text,jsonb)'::regprocedure,'public.target_shop_rpc(text,text,jsonb)'::regprocedure,'target_private.reward_points_for_roll(integer)'::regprocedure,'target_private.bonus_snapshot(uuid)'::regprocedure,'target_private.record_word_mastery()'::regprocedure,'target_private.enforce_gacha_catalog_protocol()'::regprocedure,'target_private.enforce_gacha_price_protocol()'::regprocedure) ORDER BY signature")).rows;}
async function walletAttrs(){return(await db.query("SELECT oid,proowner,prosecdef,proisstrict,provolatile,proconfig,proacl::text AS acl FROM pg_proc WHERE oid='target_private.wallet_snapshot(uuid)'::regprocedure")).rows[0];}
function wallet(value){ok(!value.error,'Real wallet succeeds');eq(value.balance+value.spent,value.totalIncome,'Balance and spending reconcile with unchanged gross income');eq(value.spent,value.drawCount*100000-value.legacyDiscountedDraws*90000+value.mapSpent,'Gacha, old map and territory spending reconcile');return value;}

const rpc=(action,body,key=secret,connection=db)=>connection.query('SELECT public.target_territory_rpc($1,$2,$3::jsonb) AS value',[key,action,JSON.stringify(body)]).then(r=>r.rows[0].value);
const state=(actor,conditional={},connection=db)=>rpc('state',{...actor,...conditional},secret,connection);
const quote=(actor,seasonId,command)=>rpc('quote',{...actor,seasonId,rulesVersion:1,command});
const actInput=(actor,seasonId,command,maxCost=1000000,options={})=>({...actor,seasonId,rulesVersion:1,command,requestId:uuid(),maxCost,...options});
const act=(actor,seasonId,command,maxCost=1000000,options={})=>rpc('act',actInput(actor,seasonId,command,maxCost,options));
const tile=(snapshot,x,y)=>snapshot.tiles[y*50+x];
const home=slot=>({x:3+((slot-1)%8)*6,y:5+Math.floor((slot-1)/8)*10});
const own=snapshot=>snapshot.players.find(p=>p.slot===snapshot.selfSlot);
const commandFor=(snapshot,type,x,y,troops,from)=>{
  const command={type,x,y,expectedTargetVersion:tile(snapshot,x,y)[2]};
  if(troops!==undefined)command.troops=troops;
  if(from)Object.assign(command,{fromX:from.x,fromY:from.y,expectedSourceVersion:tile(snapshot,from.x,from.y)[2]});
  return command;
};
async function accepted(actor,type,x,y,troops,from){
  const snapshot=await state(actor);ok(!snapshot.error,'State before command succeeds');
  const command=type==='join'?{type}:commandFor(snapshot,type,x,y,troops,from);
  const view=await quote(actor,snapshot.season.id,command);ok(!view.error,'Quote for '+type+' succeeds: '+JSON.stringify(view.error));
  const input=actInput(actor,snapshot.season.id,command,view.cost);
  const result=await rpc('act',input);ok(!result.error,'Action '+type+' succeeds: '+JSON.stringify(result.error));
  eq(result.command,command,'Command receipt remains canonical');eq(result.cost,view.cost,'Quoted exact cost is debited');eq(result.preview,view.preview,'Preview matches the deterministic accepted outcome');
  return{input,result,snapshot,view};
}
async function counts(){return(await db.query('SELECT (SELECT count(*)::integer FROM target_private.profiles) AS profiles,(SELECT count(*)::integer FROM target_private.territory_players) AS players,(SELECT count(*)::integer FROM target_private.territory_orders) AS orders,(SELECT count(*)::integer FROM target_private.territory_tiles) AS tiles')).rows[0];}
async function gameDigest(){return(await db.query("SELECT md5(coalesce((SELECT string_agg(row_to_json(t)::text,',' ORDER BY season_id,x,y) FROM target_private.territory_tiles t),'')) AS tiles,md5(coalesce((SELECT string_agg(row_to_json(p)::text,',' ORDER BY season_id,slot) FROM target_private.territory_players p),'')) AS players,(SELECT sum(spent_points)::text FROM target_private.profiles) AS spent,(SELECT count(*)::integer FROM target_private.territory_orders) AS orders")).rows[0];}

(async()=>{
  const entrants=Array.from({length:40},(_,i)=>person('参加'+String(i+1).padStart(2,'0')));
  const extra=person('満員確認'),unknown=person('未参加'),poor=person('資金なし');
  let beforeFingerprint,beforeAttrs,initial,actorsBySlot,originalClaim;
  try{
    await fresh();
    for(const actor of entrants)await seed(actor,10000000);
    await seed(extra,1000000);await seed(poor,0);
    const oldReceipt=await oldMap('buy',{...entrants[0],requestId:uuid(),shape:{type:'cell',x:2,y:2},color:1,maxCost:100,expectedUnitPrice:100,expectedOverwritePrice:1000});
    ok(!oldReceipt.error,'A historical paint receipt exists before the replacement');
    ok(!(await draw(entrants[0])).error,'A historical gacha receipt exists before the replacement');
    const preservedProfiles=(await db.query('SELECT * FROM target_private.profiles ORDER BY member_id')).rows;
    const preservedMap=(await db.query('SELECT * FROM target_private.map_purchases')).rows;
    beforeFingerprint=await fingerprint();beforeAttrs=await walletAttrs();
    await db.query(await fs.readFile(path.join(root,'supabase/migrations',migration),'utf8'));

    await scenario('Migration preserves existing quiz, gacha, old map and wallet history while retiring paint writes',async()=>{
      eq(await fingerprint(),beforeFingerprint,'Study, reward odds, gacha, bonus and mastery functions remain byte-identical');
      eq(await walletAttrs(),beforeAttrs,'The augmented wallet retains identity, owner, ACL and execution attributes');
      eq((await db.query('SELECT * FROM target_private.profiles ORDER BY member_id')).rows,preservedProfiles);
      eq((await db.query('SELECT * FROM target_private.map_purchases')).rows,preservedMap);
      const account=wallet(await shop('wallet',entrants[0]));eq(account.mapSpent,100);eq(account.spent,100100);
      for(const action of ['quote','buy'])eq((await oldMap(action,{...entrants[0],requestId:uuid(),shape:{type:'cell',x:3,y:3},color:1,maxCost:100,expectedUnitPrice:100,expectedOverwritePrice:1000})).error?.code,'MAP_REPLACED');
      eq((await db.query('SELECT count(*)::integer AS n FROM target_private.map_purchases')).rows[0].n,1);
    });
    await scenario('A fresh state reserves forty protected homes and five guarded castles without joining a viewer',async()=>{
      const before=(await db.query('SELECT count(*)::integer AS n FROM target_private.profiles')).rows[0].n;
      initial=await state(unknown);ok(!initial.error);eq(initial.rulesVersion,1);eq(initial.width,50);eq(initial.height,50);eq(initial.maxPlayers,40);eq(initial.selfSlot,null);eq(initial.players,[]);eq(initial.tiles.length,2500);eq(initial.balance,0);eq(initial.mapSpent,0);
      eq(initial.rules,{claimCost:1000,troopPrice:1000,attackCost:1000,maxTroops:1000,startTroops:10,castleGuard:8,landPointsPerMinute:1,castlePointsPerMinute:10});
      ok(/^\d{4}-\d{2}-\d{2}$/.test(initial.season.id));eq(new Date(initial.season.endsAt)-new Date(initial.season.startsAt),7*24*60*60*1000);ok(Number.isFinite(Date.parse(initial.serverNow)));
      for(let slot=1;slot<=40;slot++){const h=home(slot);eq(tile(initial,h.x,h.y),[0,0,0]);}
      const castles=[[12,12],[37,12],[25,25],[12,37],[37,37]];for(const [x,y]of castles)eq(tile(initial,x,y),[0,8,0]);
      eq(initial.tiles.filter(row=>row[1]===8).length,5);eq(initial.tiles.filter(row=>row[1]===0).length,2495);ok(Buffer.byteLength(JSON.stringify(initial))<256*1024);
      const conditional=await state(unknown,{seasonId:initial.season.id,revision:initial.revision});eq(conditional.tiles,null);eq(conditional.players,[]);
      eq(conditional.changes,[]);eq(initial.changes,[]);eq(initial.summaryMinute,Math.floor(Date.parse(initial.serverNow)/60000));
      const unchanged=await state(unknown,{seasonId:initial.season.id,revision:initial.revision,summaryMinute:initial.summaryMinute});
      eq(unchanged.tiles,null);eq(unchanged.changes,[]);eq(unchanged.players,null);eq(unchanged.events,null);eq(unchanged.notifications,null,'An unchanged same-minute poll omits all retained summaries');
      const nextMinute=await state(unknown,{seasonId:initial.season.id,revision:initial.revision,summaryMinute:initial.summaryMinute-1});eq(nextMinute.players,[]);eq(nextMinute.events,[]);eq(nextMinute.notifications,[]);
      const future=await state(unknown,{seasonId:initial.season.id,revision:initial.revision+1});eq(future.tiles.length,2500);
      eq((await db.query('SELECT count(*)::integer AS n FROM target_private.profiles')).rows[0].n,before,'Reading allocates no viewer profile');
    });
    await scenario('Strict authority and command parsing reject malformed requests before balance or board mutations',async()=>{
      const before=await gameDigest(),base={...unknown,seasonId:initial.season.id,rulesVersion:1,command:{type:'join'}};
      for(const action of ['state','quote','act'])eq((await rpc(action,action==='state'?unknown:action==='quote'?base:{...base,requestId:uuid(),maxCost:0},'bad')).error?.code,'RPC_FORBIDDEN');
      for(const value of [null,{}, {...unknown,role:'admin'},{...unknown,seasonId:initial.season.id},{...unknown,revision:0},{...unknown,seasonId:initial.season.id,revision:-1}])eq((await rpc('state',value)).error?.code,'INVALID_REQUEST');
      for(const command of [{type:'join',troops:1000},{type:'claim',x:-1,y:0,expectedTargetVersion:0},{type:'claim',x:50,y:0,expectedTargetVersion:0},{type:'claim',x:0.1,y:0,expectedTargetVersion:0},{type:'claim',x:'1',y:0,expectedTargetVersion:0},{type:'reinforce',x:1,y:1,troops:0,expectedTargetVersion:0},{type:'move',fromX:0,fromY:0,x:1,y:0,troops:1001,expectedTargetVersion:0,expectedSourceVersion:0},{type:'attack',fromX:0,fromY:0,x:1,y:0,troops:1,expectedTargetVersion:0,expectedSourceVersion:-1}])eq((await rpc('quote',{...base,command})).error?.code,'INVALID_REQUEST');
      for(const maxCost of [-1,1,100,1000001,'1000',1.1])eq((await rpc('act',{...base,requestId:uuid(),maxCost})).error?.code,'INVALID_REQUEST');
      eq((await rpc('quote',{...base,rulesVersion:2})).error?.code,'INVALID_REQUEST');eq((await rpc('quote',{...base,memberId:'forged'})).error?.code,'INVALID_REQUEST');
      eq(await gameDigest(),before,'Rejected authority/shape inputs create no player, order, charge or tile change');
    });
    await scenario('Unjoined players keep their reserved headquarters safe from early occupation or attack',async()=>{
      const actor=entrants[0],before=await gameDigest(),connection=await db.connect();
      try{
        await connection.query('BEGIN');
        const season=(await connection.query('SELECT id FROM target_private.territory_seasons WHERE starts_at=$1',[initial.season.startsAt])).rows[0].id;
        await connection.query('INSERT INTO target_private.territory_players(season_id,member_id,slot,land_count,accrued_at,joined_at) VALUES($1,$2,1,2,clock_timestamp(),clock_timestamp())',[season,actor.memberId]);
        await connection.query('UPDATE target_private.territory_tiles SET owner_slot=1,troops=10 WHERE season_id=$1 AND hq_slot=1',[season]);
        await connection.query('UPDATE target_private.territory_tiles SET owner_slot=1,troops=2 WHERE season_id=$1 AND x=8 AND y=5',[season]);
        const base={...actor,seasonId:initial.season.id,rulesVersion:1};
        eq((await rpc('quote',{...base,command:{type:'claim',x:9,y:5,expectedTargetVersion:0}},secret,connection)).error?.code,'HQ_PROTECTED');
        eq((await rpc('quote',{...base,command:{type:'attack',fromX:8,fromY:5,x:9,y:5,troops:1,expectedSourceVersion:0,expectedTargetVersion:0}},secret,connection)).error?.code,'HQ_PROTECTED');
        const tile=(await connection.query('SELECT owner_slot,troops FROM target_private.territory_tiles WHERE season_id=$1 AND hq_slot=2',[season])).rows[0];eq(tile,{owner_slot:null,troops:0},'A future participant can still receive the reserved home');
      }finally{await connection.query('ROLLBACK');connection.release();}
      eq(await gameDigest(),before,'A local fixture and failed quotes leave no persistent game data');
    });
    await scenario('Forty concurrent joins assign distinct protected homes and reject the forty-first player',async()=>{
      const commands=entrants.map(actor=>actInput(actor,initial.season.id,{type:'join'},0));
      const joined=await Promise.all(commands.map(input=>rpc('act',input)));
      for(let i=0;i<joined.length;i++){const row=joined[i];ok(!row.error,'Concurrent join '+i+' succeeds: '+JSON.stringify(row.error));eq(row.cost,0);eq(row.preview.result,'joined');eq(row.preview.targetRemaining,10);eq(row.requestId,commands[i].requestId);eq(row.replayed,false);}
      const snapshot=await state(entrants[0]);eq(snapshot.players.length,40);eq(new Set(snapshot.players.map(p=>p.slot)).size,40);eq(snapshot.tiles.filter(row=>row[0]!==0).length,40);
      actorsBySlot=new Map(snapshot.players.map(player=>[player.slot,entrants.find(actor=>actor.memberId===player.memberId)]));
      for(const player of snapshot.players){eq(player.home,home(player.slot));eq(player.landCount,1);eq(player.castleCount,0);eq(tile(snapshot,player.home.x,player.home.y).slice(0,2),[player.slot,10]);}
      const before=await gameDigest();eq((await act(extra,snapshot.season.id,{type:'join'},0)).error?.code,'PLAYER_LIMIT');eq((await act(unknown,snapshot.season.id,{type:'join'},0)).error?.code,'PLAYER_LIMIT');eq(await gameDigest(),before,'Full-board joining allocates no profile or gameplay data');
      const replay=await rpc('act',commands[0]);eq(replay.replayed,true);eq(replay.preview,joined[0].preview);eq(replay.cost,0);eq(await gameDigest(),before,'Exact join retry never replenishes the headquarters');
      const repeat=await act(entrants[0],snapshot.season.id,{type:'join'},0);ok(!repeat.error);eq(repeat.event,null);eq(repeat.cost,0);eq((await state(entrants[0])).players.length,40);
    });
    await scenario('Claims and reinforcements charge exact shared points while tile-specific versions allow unrelated changes',async()=>{
      const a=actorsBySlot.get(1),b=actorsBySlot.get(2),before=wallet(await shop('wallet',a));
      const first=await accepted(a,'claim',4,5);eq(first.result.cost,1000);eq(first.result.preview,{result:'claimed',sourceRemaining:null,targetRemaining:1,targetOwnerSlot:1});
      const after=wallet(await shop('wallet',a));eq(after.balance,before.balance-1000);eq(after.totalIncome,before.totalIncome);eq(after.mapSpent,before.mapSpent+1000);
      const delta=await state(a,{seasonId:first.snapshot.season.id,revision:first.snapshot.revision,summaryMinute:first.snapshot.summaryMinute});eq(delta.tiles,null);eq(delta.changes.length,1);eq(delta.changes[0],[5*50+4,1,1,first.result.revision]);ok(Array.isArray(delta.players),'A changed revision refreshes all summaries');
      const snapshot=await state(a),notAdjacent=commandFor(snapshot,'claim',0,0);eq((await quote(a,snapshot.season.id,notAdjacent)).error?.code,'NOT_ADJACENT');
      const next=commandFor(snapshot,'claim',5,5),nextView=await quote(a,snapshot.season.id,next);ok(!nextView.error);
      await accepted(b,'claim',8,5);
      const unrelated=await act(a,snapshot.season.id,next,nextView.cost);ok(!unrelated.error,'An unrelated global revision does not invalidate selected tile versions');
      await accepted(a,'claim',6,5);await accepted(b,'claim',7,5);
      const strengthened=await accepted(a,'reinforce',6,5,9);eq(strengthened.result.cost,9000);eq(strengthened.result.preview.targetRemaining,10);
      const current=await state(a),stale=commandFor(current,'reinforce',6,5,1);await accepted(a,'reinforce',6,5,1);
      const digest=await gameDigest();eq((await act(a,current.season.id,stale,1000)).error?.code,'BOARD_CHANGED');eq(await gameDigest(),digest,'A stale selected tile never debits or adds troops');
      const capView=await state(a),capped=commandFor(capView,'reinforce',6,5,1);eq((await act(a,capView.season.id,capped,0)).error?.code,'PRICE_CHANGED');eq(await gameDigest(),digest,'A caller cost cap prevents any higher charge');
      const foreign=commandFor(capView,'reinforce',7,5,1);eq((await quote(a,capView.season.id,foreign)).error?.code,'NOT_OWNER');
    });
    await scenario('Army movement is free, leaves one defender and enforces adjacency, ownership and garrison limits',async()=>{
      const a=actorsBySlot.get(1),before=wallet(await shop('wallet',a));
      const moved=await accepted(a,'move',4,5,3,{x:3,y:5});eq(moved.result.cost,0);eq(moved.result.preview,{result:'moved',sourceRemaining:7,targetRemaining:4,targetOwnerSlot:1});eq(wallet(await shop('wallet',a)).spent,before.spent);
      const s=await state(a);
      for(const [command,code]of [[commandFor(s,'move',4,5,7,{x:3,y:5}),'INSUFFICIENT_TROOPS'],[commandFor(s,'move',6,5,1,{x:3,y:5}),'NOT_ADJACENT'],[commandFor(s,'move',7,5,1,{x:6,y:5}),'NOT_OWNER']])eq((await quote(a,s.season.id,command)).error?.code,code);
      const fill=await accepted(a,'reinforce',4,5,996);eq(fill.result.cost,996000);eq(fill.result.preview.targetRemaining,1000);
      const full=await state(a);eq((await quote(a,full.season.id,commandFor(full,'reinforce',4,5,1))).error?.code,'TROOP_LIMIT');eq((await quote(a,full.season.id,commandFor(full,'move',4,5,1,{x:3,y:5}))).error?.code,'TROOP_LIMIT');
    });
    await scenario('Attacks resolve defense, ties and captures exactly and receipts never reclaim later ownership',async()=>{
      const a=actorsBySlot.get(1),b=actorsBySlot.get(2);
      await accepted(b,'reinforce',7,5,3);
      const lost=await accepted(a,'attack',7,5,3,{x:6,y:5});eq(lost.result.cost,1000);eq(lost.result.preview,{result:'defended',sourceRemaining:8,targetRemaining:1,targetOwnerSlot:2});
      const tied=await accepted(a,'attack',7,5,1,{x:6,y:5});eq(tied.result.preview,{result:'neutralized',sourceRemaining:7,targetRemaining:0,targetOwnerSlot:0});
      const neutral=await state(a);eq((await quote(a,neutral.season.id,commandFor(neutral,'attack',7,5,1,{x:6,y:5}))).error?.code,'INVALID_TARGET');
      originalClaim=await accepted(a,'claim',7,5);await accepted(b,'reinforce',8,5,5);
      const captured=await accepted(b,'attack',7,5,4,{x:8,y:5});eq(captured.result.preview,{result:'captured',sourceRemaining:2,targetRemaining:3,targetOwnerSlot:2});
      const before=await gameDigest(),replay=await rpc('act',originalClaim.input);eq(replay.replayed,true);eq(replay.preview,originalClaim.result.preview);eq(replay.cost,1000);eq(await gameDigest(),before,'Replaying an earlier owner claim cannot restore ownership or troops');
      eq((await rpc('act',{...originalClaim.input,maxCost:2000})).error?.code,'REQUEST_ID_CONFLICT');
      const aState=await state(a),bState=await state(b);ok(aState.notifications.some(e=>e.kind==='attack'&&e.defenderSlot===1&&e.result==='captured'));ok(bState.notifications.some(e=>e.kind==='attack'&&e.defenderSlot===2));ok(aState.events.some(e=>e.kind==='attack'&&e.result==='neutralized'));ok(aState.events.length<=20);ok(aState.notifications.length<=10);
      const hq=commandFor(aState,'attack',9,5,1,{x:8,y:5});eq((await quote(b,aState.season.id,hq)).error?.code,'HQ_PROTECTED');
      eq(wallet(await shop('wallet',a)).totalIncome,10000000,'Victories do not invent income or alter the study ranking');
    });
    await scenario('A castle requires battle against its guard and counts as ten points per minute',async()=>{
      const b=actorsBySlot.get(2);
      for(let y=6;y<=12;y++)await accepted(b,'claim',9,y);
      await accepted(b,'claim',10,12);await accepted(b,'claim',11,12);
      const before=await state(b);eq((await quote(b,before.season.id,commandFor(before,'claim',12,12))).error?.code,'INVALID_TARGET');
      await accepted(b,'reinforce',11,12,9);
      const win=await accepted(b,'attack',12,12,9,{x:11,y:12});eq(win.result.preview,{result:'captured',sourceRemaining:1,targetRemaining:1,targetOwnerSlot:2});
      const after=await state(b);eq(own(after).castleCount,1);eq(tile(after,12,12).slice(0,2),[2,1]);
      const connection=await db.connect();
      try{
        await connection.query('BEGIN');
        const p=(await connection.query('SELECT p.*,s.starts_at,s.ends_at FROM target_private.territory_players p JOIN target_private.territory_seasons s ON s.id=p.season_id WHERE p.member_id=$1 AND p.season_id=(SELECT id FROM target_private.territory_seasons WHERE starts_at=(date_trunc(\'week\',clock_timestamp() AT TIME ZONE \'Asia/Tokyo\') AT TIME ZONE \'Asia/Tokyo\'))',[b.memberId])).rows[0];
        const start=p.starts_at;
        await connection.query('UPDATE target_private.territory_players SET land_count=2,castle_count=1,score_millis=0,accrued_at=$3 WHERE season_id=$1 AND slot=$2',[p.season_id,p.slot,start]);
        await connection.query("SELECT target_private.territory_accrue($1,$2,$3::timestamptz+interval '60.125 seconds')",[p.season_id,p.slot,start]);
        let score=(await connection.query('SELECT score_millis,accrued_at FROM target_private.territory_players WHERE season_id=$1 AND slot=$2',[p.season_id,p.slot])).rows[0];eq(score.score_millis,'661375','Two land tiles including one castle accrue11points/minute');
        await connection.query("SELECT target_private.territory_accrue($1,$2,$3::timestamptz+interval '61 seconds')",[p.season_id,p.slot,start]);
        score=(await connection.query('SELECT score_millis FROM target_private.territory_players WHERE season_id=$1 AND slot=$2',[p.season_id,p.slot])).rows[0];eq(score.score_millis,'671000','Fractional elapsed time survives multiple accruals');
        await connection.query("UPDATE target_private.territory_players SET score_millis=0,accrued_at=$3::timestamptz-interval '30 seconds' WHERE season_id=$1 AND slot=$2",[p.season_id,p.slot,p.ends_at]);
        await connection.query("SELECT target_private.territory_accrue($1,$2,$3::timestamptz+interval '2 days')",[p.season_id,p.slot,p.ends_at]);
        score=(await connection.query('SELECT score_millis,accrued_at FROM target_private.territory_players WHERE season_id=$1 AND slot=$2',[p.season_id,p.slot])).rows[0];eq(score.score_millis,'330000');eq(+score.accrued_at,+p.ends_at,'Scores stop exactly at the season boundary');
        await connection.query("SELECT target_private.territory_accrue($1,$2,$3::timestamptz+interval '4 days')",[p.season_id,p.slot,p.ends_at]);eq((await connection.query('SELECT score_millis FROM target_private.territory_players WHERE season_id=$1 AND slot=$2',[p.season_id,p.slot])).rows[0].score_millis,'330000','Repeated reads/accrual never score beyond the season');
      }finally{await connection.query('ROLLBACK');connection.release();}
    });
    await scenario('Neutral castle guards can weaken, tie at zero and then be captured without extra income',async()=>{
      const actor=actorsBySlot.get(3),before=await gameDigest(),connection=await db.connect();
      try{
        await connection.query('BEGIN');
        const season=(await connection.query('SELECT id FROM target_private.territory_seasons WHERE starts_at=$1',[initial.season.startsAt])).rows[0].id;
        await connection.query('UPDATE target_private.territory_tiles SET owner_slot=3,troops=10 WHERE season_id=$1 AND x=36 AND y=12',[season]);
        await connection.query('UPDATE target_private.territory_players SET land_count=land_count+1 WHERE season_id=$1 AND slot=3',[season]);
        for(const [amount,outcome,remaining,owner,sourceLeft]of [[3,'defended',5,0,7],[5,'neutralized',0,0,2],[1,'captured',1,3,1]]){
          const cells=(await connection.query('SELECT x,troops,version FROM target_private.territory_tiles WHERE season_id=$1 AND y=12 AND x IN (36,37) ORDER BY x',[season])).rows;
          const command={type:'attack',fromX:36,fromY:12,x:37,y:12,troops:amount,expectedSourceVersion:Number(cells[0].version),expectedTargetVersion:Number(cells[1].version)};
          const result=await rpc('act',actInput(actor,initial.season.id,command,1000),secret,connection);ok(!result.error,'Neutral guard attack succeeds');eq(result.preview,{result:outcome,sourceRemaining:sourceLeft,targetRemaining:remaining,targetOwnerSlot:owner});eq(result.cost,1000);
          const target=(await connection.query('SELECT owner_slot,troops FROM target_private.territory_tiles WHERE season_id=$1 AND x=37 AND y=12',[season])).rows[0];eq(target,{owner_slot:owner||null,troops:remaining});
        }
        eq((await connection.query('SELECT castle_count FROM target_private.territory_players WHERE season_id=$1 AND slot=3',[season])).rows[0].castle_count,1);
        eq((await connection.query('SELECT total_points FROM target_private.profiles WHERE member_id=$1',[actor.memberId])).rows[0].total_points,'10000000','Neutral castle combat never grants wallet income');
      }finally{await connection.query('ROLLBACK');connection.release();}
      eq(await gameDigest(),before,'The isolated neutral-castle fixture rolls back completely');
    });

    await scenario('Simultaneous actions on the same army or target accept one receipt and one exact fee',async()=>{
      const a=actorsBySlot.get(1),before=wallet(await shop('wallet',a)),snapshot=await state(a);
      const command=commandFor(snapshot,'attack',7,5,1,{x:6,y:5});
      const [left,right]=await Promise.all([act(a,snapshot.season.id,command,1000),act(a,snapshot.season.id,command,1000)]);
      eq([left,right].filter(r=>!r.error).length,1);eq([left,right].filter(r=>r.error?.code==='BOARD_CHANGED').length,1);
      eq(wallet(await shop('wallet',a)).spent,before.spent+1000);
      const current=await state(a);eq(tile(current,6,5)[1],6);eq(tile(current,7,5)[1],2);
      const request=actInput(a,current.season.id,commandFor(current,'reinforce',6,5,1),1000);
      const receipts=await Promise.all([rpc('act',request),rpc('act',request),rpc('act',request)]);
      eq(receipts.filter(r=>r.replayed===false).length,1);eq(receipts.filter(r=>r.replayed===true).length,2);ok(receipts.every(r=>!r.error&&r.cost===1000));
      eq(wallet(await shop('wallet',a)).spent,before.spent+2000,'Concurrent exact retries debit once');
    });
    await scenario('Troop purchases, gacha and accepted quiz awards share a single nonnegative wallet',async()=>{
      const a=actorsBySlot.get(40),b=actorsBySlot.get(39);
      await db.query('UPDATE target_private.profiles SET total_points=100000 WHERE member_id=$1',[a.memberId]);
      const before=await state(a),h=home(40),command=commandFor(before,'claim',h.x-1,h.y);
      const [land,gacha]=await Promise.all([act(a,before.season.id,command,1000),draw(a)]);
      eq([land,gacha].filter(r=>!r.error).length,1);eq([land,gacha].filter(r=>r.error?.code==='INSUFFICIENT_BALANCE').length,1);
      const account=wallet(await shop('wallet',a));ok([1000,100000].includes(account.spent));eq(account.balance,100000-account.spent);
      await db.query('UPDATE target_private.profiles SET total_points=1000 WHERE member_id=$1',[b.memberId]);
      const questions=generateQuestions({book:'target1900',direction:'english',count:10,from:1,to:100,requestId:uuid()});
      const started=await quiz('start',{...b,requestId:uuid(),book:'target1900',direction:'english',from:1,to:100,questions});ok(!started.error);
      const answer={...b,quizId:started.quizId,questionId:questions[0].id,choiceId:questions[0].correctChoiceId,requestId:uuid()},s=await state(b),bh=home(39);
      const [credit,purchase]=await Promise.all([quiz('answer',answer),act(b,s.season.id,commandFor(s,'claim',bh.x-1,bh.y),1000)]);ok(credit.correct);ok(!purchase.error);
      const after=wallet(await shop('wallet',b));eq(after.totalIncome,1000+credit.awardPoints);eq(after.spent,1000);eq(after.balance,credit.awardPoints);
      eq(await quiz('answer',answer),credit);eq(wallet(await shop('wallet',b)).balance,after.balance,'Quiz and territory replays preserve accepted income and spending');
      const privateAccount=wallet(await shop('wallet',entrants[0]));ok(privateAccount.mapSpent>=100,'Historical map spending remains in the same aggregate');
    });
    await scenario('Weekly rotation uses Japan Monday midnight and old seasons cannot mutate the current board',async()=>{
      const a=actorsBySlot.get(1),before=await state(a),connection=await db.connect();
      let oldSeason,oldKey;
      try{
        await connection.query('BEGIN');await connection.query('SELECT pg_advisory_xact_lock(991101)');
        const edge=Date.parse(before.season.endsAt),dates=[new Date(edge-1).toISOString(),new Date(edge).toISOString()];
        const ids=[];for(const at of dates)ids.push((await connection.query('SELECT target_private.territory_current_season($1) AS id',[at])).rows[0].id);
        ok(ids[0]!==ids[1]);
        const rows=(await connection.query('SELECT id,starts_at,ends_at FROM target_private.territory_seasons WHERE id=ANY($1::uuid[]) ORDER BY starts_at',[ids])).rows;
        eq(rows.map(r=>r.starts_at.toISOString()),[new Date(before.season.startsAt).toISOString(),new Date(before.season.endsAt).toISOString()]);
        ok(rows.every(r=>r.starts_at.getUTCDay()===0&&r.starts_at.getUTCHours()===15&&r.starts_at.getUTCMinutes()===0),'Japan Monday midnight is Sunday15:00UTC');
        eq(rows.map(r=>+r.ends_at-+r.starts_at),[604800000,604800000]);
        const fresh=(await connection.query('SELECT count(*)::integer AS n,count(*) FILTER(WHERE owner_slot IS NOT NULL)::integer AS owned FROM target_private.territory_tiles WHERE season_id=$1',[ids[1]])).rows[0];eq(fresh.n,2500);eq(fresh.owned,0,'A newly rotated week starts a new board');
        oldSeason=(await connection.query("SELECT target_private.territory_current_season(clock_timestamp()-interval '14 days') AS id")).rows[0].id;
        oldKey=(await connection.query("SELECT to_char(starts_at AT TIME ZONE 'Asia/Tokyo','YYYY-MM-DD') AS id FROM target_private.territory_seasons WHERE id=$1",[oldSeason])).rows[0].id;
        await connection.query('COMMIT');
      }catch(error){await connection.query('ROLLBACK');throw error;}finally{connection.release();}
      const countsBefore=await counts(),digest=await gameDigest();
      eq((await act(a,oldKey,{type:'join'},0)).error?.code,'SEASON_CHANGED');eq(await gameDigest(),digest);eq(await counts(),countsBefore);
      const cross=await state(a,{seasonId:oldKey,revision:before.revision,summaryMinute:before.summaryMinute});eq(cross.tiles.length,2500);ok(Array.isArray(cross.players));eq(cross.changes,[],'A different season key always returns a fresh board image');
      const request=actInput(a,oldKey,{type:'join'},0),original={rulesVersion:1,seasonId:oldKey,revision:1,command:{type:'join'},cost:0,preview:{result:'joined',sourceRemaining:null,targetRemaining:10,targetOwnerSlot:1},requestId:request.requestId,replayed:false,event:null};
      // Accepted historical receipts are synthetic fixtures in the local DB.
      // The current RPC still performs all replay validation and wallet reads.
      await db.query("INSERT INTO target_private.territory_orders(member_id,request_id,season_id,request_hash,kind,actor_slot,cost,result,created_at) VALUES($1,$2,$3,encode(sha256(convert_to(jsonb_build_object('seasonId',$4::text,'rulesVersion',1,'command',$5::jsonb,'maxCost',0)::text,'UTF8')),'hex'),'join',1,0,$6::jsonb,clock_timestamp()-interval '14 days')",[a.memberId,request.requestId,oldSeason,oldKey,JSON.stringify(request.command),JSON.stringify(original)]);
      const afterInsert=await gameDigest(),replay=await rpc('act',request);ok(!replay.error,'A valid receipt replays after weekly rotation: '+JSON.stringify(replay.error));eq(replay.replayed,true);eq(replay.seasonId,oldKey);eq(replay.preview,original.preview);eq(replay.event,null);eq(await gameDigest(),afterInsert,'Historical replay does not restore old troops or ownership');
      eq((await rpc('act',{...request,maxCost:1000})).error?.code,'REQUEST_ID_CONFLICT','Even an old UUID rejects a changed payload');
    });
    await scenario('Capacity failures leave charges and armies untouched while accepted receipts remain replayable',async()=>{
      const a=actorsBySlot.get(1),s=await state(a),command=commandFor(s,'reinforce',6,5,1),before=await gameDigest(),used=(await db.query('SELECT logical_bytes FROM target_private.system_state WHERE singleton')).rows[0].logical_bytes;
      await db.query('UPDATE target_private.system_state SET logical_bytes=104857600 WHERE singleton');
      try{
        eq((await act(a,s.season.id,command,1000)).error?.code,'CAPACITY_LIMIT');eq(await gameDigest(),before,'Storage refusal cannot charge, reinforce, score or append a command');
        const replay=await rpc('act',originalClaim.input);eq(replay.replayed,true);eq(replay.cost,1000);eq(await gameDigest(),before,'An already accepted receipt remains available at the capacity ceiling');
      }finally{await db.query('UPDATE target_private.system_state SET logical_bytes=$1 WHERE singleton',[used]);}
    });
    await scenario('Immutable private game data and helper permissions prevent direct client mutation',async()=>{
      const tables=['territory_seasons','territory_players','territory_tiles','territory_orders'];
      const access=(await db.query("SELECT c.relname,c.relrowsecurity,NOT EXISTS(SELECT 1 FROM pg_roles r CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) privilege WHERE r.rolname IN ('anon','authenticated','service_role') AND has_table_privilege(r.oid,c.oid,privilege)) AS private FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='target_private' AND c.relname=ANY($1::text[]) ORDER BY c.relname",[tables])).rows;
      eq(access.length,4);ok(access.every(r=>r.relrowsecurity&&r.private));
      const functions=(await db.query("SELECT p.proname,NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname IN ('anon','authenticated','service_role') AND has_function_privilege(r.oid,p.oid,'EXECUTE')) AS private FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='target_private' AND p.proname LIKE 'territory_%'")).rows;ok(functions.length>=4);ok(functions.every(r=>r.private));
      const entry=(await db.query("SELECT prosecdef,proconfig FROM pg_proc WHERE oid='public.target_territory_rpc(text,text,jsonb)'::regprocedure")).rows[0];eq(entry.prosecdef,true);ok(entry.proconfig.includes('search_path=pg_catalog'));
      for(const query of ['UPDATE target_private.territory_orders SET cost=cost','DELETE FROM target_private.territory_orders']){await assert.rejects(db.query(query),error=>error.code==='42501');checks++;}
      const client=await db.connect();try{
        await client.query('SET ROLE anon');eq((await rpc('state',entrants[0],'bad',client)).error?.code,'RPC_FORBIDDEN');
        for(const table of tables){await assert.rejects(client.query('SELECT * FROM target_private.'+table),error=>error.code==='42501');checks++;}
        await assert.rejects(client.query("SELECT target_private.territory_current_season(clock_timestamp())"),error=>error.code==='42501');checks++;
      }finally{await client.query('RESET ROLE');client.release();}
      eq(await fingerprint(),beforeFingerprint);eq(await walletAttrs(),beforeAttrs);
      const final=await state(actorsBySlot.get(1));eq(final.players.length,40);ok(final.events.length<=20&&final.notifications.length<=10);ok(Buffer.byteLength(JSON.stringify(final))<256*1024);eq(final.tiles.length,2500);ok(final.tiles.every(t=>t.length===3&&Number.isInteger(t[0])&&t[0]>=0&&t[0]<=40&&Number.isInteger(t[1])&&t[1]>=0&&t[1]<=1000&&Number.isSafeInteger(t[2])));
      results.push({name:'Bounded state measurements',status:'measurement',players:final.players.length,tiles:final.tiles.length,fullResponseBytes:Buffer.byteLength(JSON.stringify(final)),events:final.events.length,notifications:final.notifications.length});
    });
    passed=true;
  }catch(error){console.error('Territory DB verification failed at '+phase+': '+(error.code||error.name)+' '+error.message+' '+(error.stack||'').split('\n').filter(line=>line.includes('territory-db.cjs:')).at(-1));process.exitCode=1;}
  finally{
    await db.end();
    const report={generatedAt:new Date().toISOString(),status:passed?'passed':'failed',phase,checks,results,hostedWrites:0,realAccounts:0};
    await fs.mkdir(path.join(root,'test-results'),{recursive:true});await fs.writeFile(path.join(root,'test-results/territory-db-results.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,checks,scenarios:results.filter(r=>r.status==='passed').length,hostedWrites:0}));
  }
})().catch(error=>{console.error(error.name+': '+error.message);process.exitCode=1;});
