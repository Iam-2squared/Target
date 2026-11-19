'use strict';
// Durable removal verification in an isolated loopback database. No hosted bets.
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs/promises'),path=require('node:path');
const {Client,Pool}=require('pg'),{generateQuestions}=require('../server/questions.cjs');
assert.equal(process.env.NODE_ENV,'test');
const source=new URL(process.env.DATABASE_URL||'');assert(['localhost','127.0.0.1','[::1]'].includes(source.hostname));
const dbName='target_gambling_removal_test',url=new URL(source),adminURL=new URL(source);url.pathname='/'+dbName;adminURL.pathname='/postgres';
const dir=path.resolve(__dirname,'../supabase/migrations'),migration='20261109111133_target_gambling_removed.sql',baseline='20261109084513_target_section_mastery_achievements.sql';
const db=new Pool({connectionString:url.href,max:8}),uuid=()=>crypto.randomUUID(),secret=crypto.randomBytes(32).toString('base64url');
const member={memberId:uuid(),name:'終了検証'},play=()=>({...member,requestId:uuid(),game:'plinko',stake:100,choice:null,rulesVersion:5});
let checks=0,phases=[];
const eq=(a,b,m)=>{checks++;assert.deepEqual(a,b,m);},ok=(v,m)=>{checks++;assert(v,m);};
const rpc=(action,input,client=db,key=secret)=>client.query('SELECT public.target_games_rpc($1,$2,$3::jsonb) v',[key,action,JSON.stringify(input)]).then(r=>r.rows[0].v);
const old=(action,input,client=db)=>client.query('SELECT target_private.removal_old_rpc($1,$2,$3::jsonb) v',[secret,action,JSON.stringify(input)]).then(r=>r.rows[0].v);
const snapshot=()=>rpc('snapshot',{memberId:member.memberId});
async function state(){return(await db.query("SELECT jsonb_build_object('profiles',(SELECT jsonb_agg(to_jsonb(p) ORDER BY member_id) FROM target_private.profiles p),'rounds',(SELECT jsonb_agg(to_jsonb(r) ORDER BY member_id,request_id) FROM target_private.casino_rounds r),'batches',(SELECT jsonb_agg(to_jsonb(b) ORDER BY member_id,request_id) FROM target_private.casino_batches b),'links',(SELECT jsonb_agg(to_jsonb(l) ORDER BY member_id,batch_request_id,ball_index) FROM target_private.casino_batch_rounds l),'quota',(SELECT jsonb_agg(to_jsonb(q) ORDER BY identifier,bucket) FROM target_private.rate_limits q),'system',(SELECT to_jsonb(s) FROM target_private.system_state s)) v")).rows[0].v;}
async function functions(){return(await db.query("SELECT jsonb_object_agg(n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')',md5(p.prosrc)) v FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE (n.nspname='target_private' OR(n.nspname='public' AND p.proname LIKE 'target%')) AND prokind='f'")).rows[0].v;}
async function rejected(query,params=[],client=db){await assert.rejects(client.query(query,params),error=>error.code==='42501');checks++;}
async function phase(name,fn){await fn();phases.push(name);console.log('PASS '+name);}
async function waitForAdvisory(client,pid){for(let i=0;i<100;i++){const r=await client.query("SELECT wait_event_type,wait_event FROM pg_stat_activity WHERE pid=$1",[pid]);if(r.rows[0]?.wait_event==='advisory')return;await new Promise(resolve=>setTimeout(resolve,20));}throw Error('Old writer did not queue on the shared lock');}
(async()=>{try{
 const admin=new Client({connectionString:adminURL.href});await admin.connect();try{await admin.query('DROP DATABASE IF EXISTS '+dbName+' WITH (FORCE)');await admin.query('CREATE DATABASE '+dbName);}finally{await admin.end();}
 for(const file of(await fs.readdir(dir)).filter(f=>/^\d+_.*\.sql$/.test(f)&&f<=baseline).sort())await db.query(await fs.readFile(path.join(dir,file),'utf8'));
 await db.query("INSERT INTO target_private.server_credentials(singleton,key_hash) VALUES(true,encode(sha256(convert_to($1,'UTF8')),'hex'))",[secret]);
 await db.query('INSERT INTO target_private.profiles(member_id,name,total_points,correct_count,answered_count) VALUES($1,$2,1000000,10,10)',[member.memberId,member.name]);
 await db.query('CREATE SEQUENCE target_private.removal_test_entropy MINVALUE 0 START 0');
 await db.query("CREATE OR REPLACE FUNCTION target_private.secure_random_int(p_bound integer) RETURNS integer LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$ DECLARE n bigint; BEGIN IF p_bound<>2 THEN RETURN 0; END IF; n:=nextval('target_private.removal_test_entropy'); RETURN CASE WHEN n%16<8 THEN 1 ELSE 0 END; END $$");
 const single=play(),batch={...play(),count:3},singleReceipt=await rpc('play',single),batchReceipt=await rpc('batch',batch);
 eq(singleReceipt.round.net,-80);eq(batchReceipt.batch.net,-240);
 const definition=(await db.query("SELECT pg_get_functiondef('public.target_games_rpc(text,text,jsonb)'::regprocedure) d")).rows[0].d;
 await db.query(definition.replace('public.target_games_rpc(', 'target_private.removal_old_rpc('));
 const before=await state(),beforeWallet=await snapshot(),beforeFunctions=await functions(),beforeEntropy=(await db.query('SELECT last_value,is_called FROM target_private.removal_test_entropy')).rows[0];
 await phase('queued old writer is fenced before randomness, quota or settlement',async()=>{
  const holder=await db.connect(),waiter=await db.connect();let queued;
  try{await holder.query('BEGIN');await holder.query('SELECT pg_advisory_xact_lock(991101)');const pid=(await waiter.query('SELECT pg_backend_pid() pid')).rows[0].pid;
   queued=old('batch',{...play(),count:100},waiter).then(result=>({result}),error=>({error}));await waitForAdvisory(holder,pid);
   // The migration's BEGIN is harmless inside this test-held transaction; its
   // COMMIT publishes the replacement trigger helpers before releasing the lock.
   await holder.query(await fs.readFile(path.join(dir,migration),'utf8'));
   const resumed=await queued;eq(resumed.error?.code,'42501');eq(await state(),before);eq(await snapshot(),beforeWallet);
   eq((await db.query('SELECT last_value,is_called FROM target_private.removal_test_entropy')).rows[0],beforeEntropy);
  }finally{await holder.query('ROLLBACK');holder.release();waiter.release();}
 });
 await phase('removal preserves all prior receipts, wallet state and unrelated function definitions',async()=>{
  const afterFunctions=await functions(),changed=Object.keys(beforeFunctions).filter(k=>beforeFunctions[k]!==afterFunctions[k]);
  eq(changed.sort(),['public.target_games_rpc(p_secret text, p_action text, p_input jsonb)','target_private.enforce_game_ball_rate_protocol()','target_private.enforce_game_rules_protocol()'].sort());
  eq(await state(),before);eq(await snapshot(),beforeWallet);
  eq((await old('play',single)).round,singleReceipt.round);eq((await old('batch',batch)).batch,batchReceipt.batch);
  eq(await state(),before,'An already committed old-body replay remains a pure read');
 });
 await phase('all public game operations are gone, including historical replay UUIDs',async()=>{
  for(const[action,input]of[['state',member],['play',single],['play',play()],['batch',batch],['batch',{...play(),count:100}],['state',null],['play',[]]]){
   const r=await rpc(action,input);eq(r.error?.status,410);eq(r.error?.code,'GAMES_REMOVED');eq(Object.keys(r),['error']);
  }
  for(const action of['state','play','batch','snapshot'])eq((await rpc(action,{},db,'wrong')).error?.code,'RPC_FORBIDDEN');
  eq((await rpc('unknown',{})).error?.code,'INVALID_REQUEST');eq((await rpc('snapshot',[])).error?.code,'INVALID_REQUEST');eq((await rpc('snapshot',{memberId:member.memberId,name:'forged'})).error?.code,'INVALID_REQUEST');
  eq(await state(),before);eq((await db.query('SELECT last_value,is_called FROM target_private.removal_test_entropy')).rows[0],beforeEntropy);
 });
 await phase('old bodies and protocol flags cannot create single rounds or batches',async()=>{
  for(const action of['play','batch']){const input=action==='play'?play():{...play(),count:100};await assert.rejects(old(action,input),error=>error.code==='42501');checks++;}
  const marked=await db.connect();
  try{
   await marked.query("SELECT set_config('target.game_ball_protocol','weighted-v1',false),set_config('target.game_payout_protocol','rules-v5',false)");
   await rejected('INSERT INTO target_private.casino_rounds SELECT member_id,$1,rules_version,game,stake,choice,outcome,multiplier,payout,net,created_at FROM target_private.casino_rounds LIMIT 1',[uuid()],marked);
   await rejected('INSERT INTO target_private.casino_batches SELECT member_id,$1,game,stake,choice,rules_version,ball_count,total_stake,total_payout,net,created_at FROM target_private.casino_batches LIMIT 1',[uuid()],marked);
   await rejected('INSERT INTO target_private.casino_batch_rounds SELECT * FROM target_private.casino_batch_rounds LIMIT 1',[],marked);
  }finally{await marked.query("SELECT set_config('target.game_ball_protocol','',false),set_config('target.game_payout_protocol','',false)");marked.release();}
  eq(await state(),before);eq((await db.query('SELECT last_value,is_called FROM target_private.removal_test_entropy')).rows[0],beforeEntropy);
 });
 await phase('game quota writes are blocked while unrelated rate limits still work',async()=>{
  await rejected("INSERT INTO target_private.rate_limits(identifier,bucket,attempt_count,expires_at) VALUES($1,0,1,clock_timestamp()+interval '1 minute')",['games-play:'+uuid()]);
  await rejected("UPDATE target_private.rate_limits SET attempt_count=attempt_count+1 WHERE identifier LIKE 'games-play:%'");
  await rejected("UPDATE target_private.rate_limits SET identifier='renamed' WHERE identifier LIKE 'games-play:%'");
  eq(await state(),before);eq((await db.query("SELECT target_private.consume_rate('ordinary-removal-test',60,10) v")).rows[0].v,0);
 });
 await phase('read-only wallet compatibility and the private privilege surface remain intact',async()=>{
  eq(await snapshot(),beforeWallet);const c=await db.connect();try{await c.query('SET ROLE anon');eq((await rpc('state',member,c)).error?.code,'GAMES_REMOVED');eq(await rpc('snapshot',{memberId:member.memberId},c),beforeWallet);}finally{await c.query('RESET ROLE');c.release();}
  const acl=(await db.query("SELECT has_function_privilege('anon','public.target_games_rpc(text,text,jsonb)','EXECUTE') rpc,has_function_privilege('authenticated','public.target_games_rpc(text,text,jsonb)','EXECUTE') auth_rpc,has_function_privilege('anon','target_private.enforce_game_rules_protocol()','EXECUTE') helper,has_table_privilege('anon','target_private.casino_rounds','INSERT') rounds,has_table_privilege('authenticated','target_private.casino_batch_rounds','INSERT') links")).rows[0];
  eq(acl,{rpc:true,auth_rpc:false,helper:false,rounds:false,links:false});
 });
 await phase('ordinary learning still accepts answers and exposes the same wallet bridge',async()=>{
  await db.query("CREATE OR REPLACE FUNCTION target_private.reward_points_for_roll(p_roll integer) RETURNS integer LANGUAGE sql IMMUTABLE STRICT SECURITY INVOKER SET search_path=pg_catalog AS 'SELECT 1000'");
  const questions=generateQuestions({book:'target1900',direction:'english',count:10,from:1,to:1,requestId:uuid()});
  const start=(await db.query('SELECT public.target_rpc($1,$2,$3::jsonb) v',[secret,'start',JSON.stringify({...member,requestId:uuid(),book:'target1900',direction:'english',from:1,to:1,questions})])).rows[0].v;ok(start.quizId);
  const receipt=(await db.query('SELECT public.target_rpc($1,$2,$3::jsonb) v',[secret,'answer',JSON.stringify({...member,quizId:start.quizId,questionId:questions[0].id,choiceId:questions[0].correctChoiceId,requestId:uuid()})])).rows[0].v;
  eq(receipt.correct,true);eq(receipt.awardPoints,1000);eq((await snapshot()).totalIncome,beforeWallet.totalIncome+1000);
  eq((await db.query('SELECT count(*)::integer n FROM target_private.casino_rounds')).rows[0].n,4);
 });
 const report={status:'passed',checks,phases,hostedWrites:0,database:dbName,retainedRounds:4,retainedBatches:1};
 await fs.writeFile(process.env.GAMBLING_REMOVAL_REPORT||'/workspace/scratch/gambling-removal-db-results.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}catch(error){console.error('Gambling removal verification failed: '+error.name+' '+String(error.message).replaceAll(secret,'[redacted]').replace(/\s+/g,' ').slice(0,250));process.exitCode=1;}finally{await db.end();}})();
