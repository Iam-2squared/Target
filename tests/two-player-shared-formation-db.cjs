'use strict';
// Disposable local PostgreSQL only. This does not read or authenticate real accounts.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const {Client} = require('pg');
const migration = '20261109231048_target_two_player_shared_random_formation.sql';
const root = path.resolve(__dirname, '..');
const name = 'two_player_shared_' + process.pid + '_test';
const uuid = () => crypto.randomUUID();
const secret = crypto.randomBytes(32).toString('base64url');
let admin, db, stale, created = false, checks = 0;
function eq(actual, expected, message) { checks++; assert.deepEqual(actual, expected, message); }
function ok(value, message) { checks++; assert.ok(value, message); }
async function source(oid) { return (await db.query('SELECT prosrc FROM pg_proc WHERE oid=$1::regprocedure',[oid])).rows[0].prosrc; }
async function rpc(member, action, input = {}, requestId = uuid()) {
  const body = {memberId:member.id,name:member.name,...input};
  if (!['wallet','state'].includes(action)) body.requestId = requestId;
  return (await db.query('SELECT public.two_player_rpc($1,$2,$3::jsonb) AS result',[secret,action,JSON.stringify(body)])).rows[0].result;
}
async function lobby(member, action, input = {}, requestId = uuid()) {
  const body = {memberId:member.id,name:member.name,sessionId:member.session,...input};
  if (!['snapshot','heartbeat','leave','logout'].includes(action)) body.requestId = requestId;
  return (await db.query('SELECT public.two_player_lobby_rpc($1,$2,$3::jsonb) AS result',[secret,action,JSON.stringify(body)])).rows[0].result;
}
async function mirror(match, label) {
  const stored=(await db.query('SELECT host_formation,guest_formation FROM target_private.two_player_matches WHERE id=$1',[match.id])).rows[0];
  eq(stored.host_formation,stored.guest_formation,label+': same stored formation');
  eq(match.host.formation,stored.host_formation,label+': host DTO formation');
  if (match.guest) eq(match.guest.formation,stored.guest_formation,label+': guest DTO formation');
  ok([0,1,2].includes(match.host.formation),label+': existing layout');
  const initial = (await db.query('SELECT target_private.two_player_initial_state($1,$1) AS state',[match.host.formation])).rows[0].state;
  eq(match.state,initial,label+': initial positions');
  for (let i=0;i<8;i++) {
    eq(match.state.players[i].x+match.state.players[i+8].x,640,label+': x mirror');
    eq(match.state.players[i].y+match.state.players[i+8].y,960,label+': y mirror');
  }
}
async function cancel(a,b,match) { await rpc(a,'cancel',{matchId:match.id}); await rpc(b,'cancel',{matchId:match.id}); }
async function seed(member) {
  await db.query('INSERT INTO target_private.profiles(member_id,name) VALUES($1,$2)',[member.id,member.name]);
  const quiz=uuid(), question=uuid(), choice=uuid(), request=uuid();
  await db.query("INSERT INTO target_private.quizzes(id,member_id,request_id,book,direction,from_number,to_number,questions,total,answered_count,correct_count,quiz_points,charged_bytes) VALUES($1,$2,$3,'target1900','english',1,1,$4::jsonb,1,1,1,10000,512)",[quiz,member.id,uuid(),JSON.stringify([{id:question,number:1,correctChoiceId:choice}])]);
  await db.query('INSERT INTO target_private.answers(quiz_id,member_id,question_id,choice_id,request_id,request_ids,response,award_points,charged_bytes) VALUES($1,$2,$3,$4,$5,ARRAY[$5::uuid],$6::jsonb,10000,512)',[quiz,member.id,question,choice,request,JSON.stringify({correct:true,awardPoints:10000})]);
  await db.query('UPDATE target_private.profiles SET total_points=10000,correct_count=1,answered_count=1 WHERE member_id=$1',[member.id]);
}
async function main() {
  eq(process.env.NODE_ENV,'test','NODE_ENV=test required');
  const url=new URL(process.env.DATABASE_URL||'');
  ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&!url.search&&!url.hash,'loopback database required');
  const adminUrl=new URL(url); adminUrl.pathname='/postgres';
  admin=new Client({connectionString:adminUrl.href}); await admin.connect();
  await admin.query('CREATE DATABASE "'+name+'"'); created=true;
  url.pathname='/'+name; db=new Client({connectionString:url.href}); await db.connect();
  await db.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; END $$");
  const dir=path.join(root,'supabase/migrations');
  for (const file of (await fs.readdir(dir)).filter(x=>/^\d+_.*\.sql$/.test(x)&&x<migration).sort()) await db.query(await fs.readFile(path.join(dir,file),'utf8'));
  await db.query("INSERT INTO target_private.two_player_credentials(singleton,key_hash) VALUES(true,encode(sha256(convert_to($1,'UTF8')),'hex'))",[secret]);
  const players=Array.from({length:6},(_,i)=>({id:uuid(),name:'fixture'+i,session:crypto.randomBytes(32).toString('hex')}));
  for (const member of players) await seed(member);
  const [a,b,c,d,e,f]=players;

  // Preserve a genuinely funded old game, including asymmetric chosen layouts.
  let old=(await rpc(a,'create',{stake:100})).match;
  await rpc(b,'join',{code:old.code});
  await rpc(a,'formation',{matchId:old.id,formation:1});
  await rpc(b,'formation',{matchId:old.id,formation:2});
  await rpc(a,'ready',{matchId:old.id,ready:true});
  old=(await rpc(b,'ready',{matchId:old.id,ready:true})).match;
  eq(old.status,'playing','old fixture funded');
  const oldRow=(await db.query('SELECT to_jsonb(m) AS row FROM target_private.two_player_matches m WHERE id=$1',[old.id])).rows[0].row;
  const oldReceipts=(await db.query('SELECT jsonb_agg(to_jsonb(e) ORDER BY member_id,phase) AS value FROM target_private.two_player_wallet_events e')).rows[0].value;
  const oldPublic=await source('public.two_player_rpc(text,text,jsonb)');
  const oldPair=await source('target_private.two_player_lobby_pair(text,uuid,uuid,integer,integer,integer,integer)');
  const oldFinance=await source('target_private.wallet_finance_projection(timestamptz)');
  const waiting=(await rpc(c,'create',{stake:100})).match;
  await rpc(d,'join',{code:waiting.code});
  await rpc(c,'formation',{matchId:waiting.id,formation:1});
  const waitingBefore=(await db.query('SELECT to_jsonb(m) AS row FROM target_private.two_player_matches m WHERE id=$1',[waiting.id])).rows[0].row;
  // An actual old function invocation compiles and pauses before the cutover.
  // Its UPDATE must still encounter the new table trigger after it resumes.
  stale=new Client({connectionString:url.href}); await stale.connect();
  const stalePid=(await stale.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  await db.query('BEGIN'); await db.query('SELECT pg_advisory_xact_lock(991101)');
  const staleCall=stale.query('SELECT public.two_player_rpc($1,$2,$3::jsonb)',[secret,'formation',JSON.stringify({memberId:c.id,name:c.name,requestId:uuid(),matchId:waiting.id,formation:0})]).then(()=>null,error=>error.code);
  let waitingOnLock=false;
  for (let i=0;i<100&&!waitingOnLock;i++) {
    waitingOnLock=(await db.query("SELECT EXISTS(SELECT FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock' AND wait_event='advisory') AS waiting",[stalePid])).rows[0].waiting;
    if (!waitingOnLock) await new Promise(resolve=>setTimeout(resolve,10));
  }
  ok(waitingOnLock,'pre-cutover manual call is actually paused on the global lock');
  await db.query(await fs.readFile(path.join(dir,migration),'utf8'));
  eq(await staleCall,'23514','actual compiled old manual call rolls back after cutover');
  await stale.end(); stale=null;
  eq((await db.query('SELECT to_jsonb(m) AS row FROM target_private.two_player_matches m WHERE id=$1',[waiting.id])).rows[0].row,waitingBefore,'stale manual call changes no match columns');
  await cancel(c,d,waiting);
  eq((await db.query('SELECT to_jsonb(m) AS row FROM target_private.two_player_matches m WHERE id=$1',[old.id])).rows[0].row,oldRow,'migration preserves every old funded match column');
  eq((await db.query('SELECT jsonb_agg(to_jsonb(e) ORDER BY member_id,phase) AS value FROM target_private.two_player_wallet_events e')).rows[0].value,oldReceipts,'migration preserves permanent financial receipts');
  eq(await source('target_private.wallet_finance_projection(timestamptz)'),oldFinance,'financial projection byte-identical');
  const added="  IF p_action='formation' THEN\n    RETURN target_private.error_result(409,'FORMATION_FIXED','陣形は対戦ごとに自動で決まります。');\n  END IF;\n";
  eq((await source('public.two_player_rpc(text,text,jsonb)')).replace(added,''),oldPublic,'all existing soccer branches byte-identical');
  ok(oldPair.includes("p_secret,'formation'"),'fixture used manual lobby formations before migration');
  ok(!(await source('target_private.two_player_lobby_pair(text,uuid,uuid,integer,integer,integer,integer)')).includes("p_secret,'formation'"),'lobby no longer applies caller layouts');
  eq((await rpc(a,'formation',{matchId:old.id,formation:0})).error?.code,'FORMATION_FIXED','legacy action rejected');
  let blocked=false; try { await db.query('UPDATE target_private.two_player_matches SET host_formation=0 WHERE id=$1',[old.id]); } catch(error) { blocked=error.code==='23514'; }
  ok(blocked,'table trigger rejects stale compiled manual change');
  await cancel(a,b,old);
  eq((await rpc(a,'wallet')).wallet.balance,10000,'old host gets exact original refund');
  eq((await rpc(b,'wallet')).wallet.balance,10000,'old guest gets exact original refund');

  // Legacy create/join and retries are covered by the same table boundary.
  const createId=uuid(); let game=(await rpc(a,'create',{stake:100},createId)).match;
  await mirror(game,'legacy create');
  const selected=game.host.formation;
  eq((await rpc(a,'create',{stake:100},createId)).match.host.formation,selected,'create retry does not reroll');
  game=(await rpc(b,'join',{code:game.code})).match; await mirror(game,'join');
  await rpc(a,'ready',{matchId:game.id,ready:true});
  game=(await rpc(b,'ready',{matchId:game.id,ready:true})).match;
  eq(game.host.formation,selected,'funding does not reroll'); await mirror(game,'funding');
  // A synthetic trusted-server goal must reset positions to this exact layout.
  const actor=game.turn==='host'?a:b;
  const input=await rpc(actor,'input',{matchId:game.id,round:game.round,version:2,piece:7,angle:270,power:10});
  ok(input._processing?.claimToken,'trusted server owns a shot lease');
  const resolved=await rpc(actor,'resolve',{matchId:game.id,round:game.round,version:2,claimToken:input._processing.claimToken,goal:'host',state:game.state,frames:[game.state]});
  ok(resolved.ok,'synthetic trusted result accepted');
  eq(resolved.match.host.formation,selected,'goal does not reroll'); await mirror(resolved.match,'goal reset');
  await cancel(a,b,resolved.match);

  // Explicit client layout choices cannot affect direct invitations or FIFO.
  for (const member of [c,d,e,f]) ok((await lobby(member,'heartbeat')).ok,'synthetic member online');
  const invitation=await lobby(c,'challenge',{targetId:d.id,stake:100,formation:1});
  const acceptId=uuid(), invitationId=invitation.lobby.outgoing[0].id;
  const direct=await lobby(d,'accept',{invitationId,stake:100,formation:2},acceptId);
  ok(direct.ok,'direct invitation accepts different legacy requested layouts'); await mirror(direct.match,'direct invitation');
  const replay=await lobby(d,'accept',{invitationId,stake:100,formation:2},acceptId);
  eq(replay.match.state,direct.match.state,'accept retry keeps random layout');
  await cancel(c,d,direct.match);
  ok((await lobby(e,'queue',{stake:100,formation:2})).ok,'FIFO head queued');
  const fifo=await lobby(f,'queue',{stake:100,formation:1});
  ok(fifo.match,'FIFO creates a match'); await mirror(fifo.match,'FIFO'); await cancel(e,f,fifo.match);
  for (const role of ['anon','authenticated','service_role']) eq((await db.query("SELECT has_function_privilege($1,'target_private.two_player_shared_formation()','EXECUTE') AS allowed",[role])).rows[0].allowed,false,'private trigger cannot be called by '+role);
  // A fixed local PRNG seed exercises all three server-selected layouts without
  // relying on a flaky distribution assertion against the live generator.
  await db.query('BEGIN');
  await db.query('SELECT setseed(0.3125)');
  await db.query("INSERT INTO target_private.two_player_matches(code,status,host_id,host_name,host_offer,settled_at) SELECT 'F'||translate(lpad(n::text,5,'0'),'0123456789','ABCDEFGHJK'),'cancelled',$1,'synthetic',100,clock_timestamp() FROM generate_series(1,48) n",[a.id]);
  eq((await db.query("SELECT count(DISTINCT host_formation)::integer AS count FROM target_private.two_player_matches WHERE host_name='synthetic'")).rows[0].count,3,'all three existing layouts can be selected');
  eq((await db.query("SELECT count(*)::integer AS count FROM target_private.two_player_matches WHERE host_name='synthetic' AND (host_formation<>guest_formation OR state IS DISTINCT FROM target_private.two_player_initial_state(host_formation,guest_formation))")).rows[0].count,0,'all samples share the selected mirrored layout');
  await db.query('ROLLBACK');
  for (const file of ['two_player_soccer_verify.sql','two_player_lobby_verify.sql','two_player_shared_formation_verify.sql']) {
    await db.query(await fs.readFile(path.join(root,'supabase/tests',file),'utf8'));
    ok(true,'read-only '+file+' passes');
  }
  const hashes=(await db.query("SELECT proname,md5(prosrc) AS hash FROM pg_proc WHERE oid IN ('public.two_player_rpc(text,text,jsonb)'::regprocedure,'target_private.two_player_lobby_pair(text,uuid,uuid,integer,integer,integer,integer)'::regprocedure,'target_private.two_player_shared_formation()'::regprocedure)")).rows;
  console.log(JSON.stringify({result:'passed',checks,hashes}));
}
main().catch(error=>{console.error('FAIL '+error.message.split(secret).join('[credential]'));process.exitCode=1;}).finally(async()=>{
  if(stale) await stale.end();
  if(db) await db.end();
  if(admin) { if(created) await admin.query('DROP DATABASE "'+name+'"'); await admin.end(); }
});
