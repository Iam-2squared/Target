'use strict';
// Destructive fixtures are restricted to a fresh disposable localhost database.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {Client}=require('pg');
const {questionBlock}=require('../server/challenge.cjs');
const uid=()=>crypto.randomUUID(),secret=crypto.randomBytes(40).toString('hex');
const dbName='target_challenge_'+process.pid+'_'+crypto.randomBytes(4).toString('hex')+'_test';
const root=path.resolve(__dirname,'..');
const member={memberId:uid(),name:'Challenge Host',sessionHash:crypto.randomBytes(32).toString('hex')};
const stranger={memberId:uid(),name:'Challenge Guest',sessionHash:crypto.randomBytes(32).toString('hex')};
let admin,db,other,created=false,checks=0,lastAnswerInput,baselineBytes=0n;
const eq=(a,b,message)=>{checks++;assert.deepEqual(a,b,message);};
const ok=(a,message)=>{checks++;assert(a,message);};
async function rpc(action,params={},actor=member,client=db,key=secret){
 const data={...actor,...params};
 if(['start','answer','pause','resume','abort'].includes(action)&&!data.requestId)data.requestId=uid();
 return (await client.query('SELECT public.target_challenge_rpc($1,$2,$3::jsonb) x',[key,action,JSON.stringify(data)])).rows[0].x;
}
async function start(level=1,actor=member){const value=await rpc('start',{level},actor);ok(value.ok,JSON.stringify(value));return value.run;}
async function supply(run,actor=member){
 if(run.status==='paused')run=(await rpc('resume',{runId:run.id},actor)).run;
 if(run.status==='playing'&&!run.question){const value=await rpc('next',{runId:run.id,questions:questionBlock(run.level)},actor);ok(value.ok,JSON.stringify(value));return value.run;}
 return run;
}
async function answer(run,correct=true,requestId=uid(),actor=member){
 run=await supply(run,actor);
 const q=(await db.query('SELECT questions->0 q FROM target_private.challenge_runs WHERE id=$1',[run.id])).rows[0].q;
 const choice=correct?q.correctChoiceId:q.choices.find(c=>c.id!==q.correctChoiceId).id;
 lastAnswerInput={runId:run.id,questionId:q.id,choiceId:choice,requestId};
 return rpc('answer',lastAnswerInput,actor);
}
async function clear(level,actor=member){
 let r=await start(level,actor),last;
 if(level>=7){
  const invalid=questionBlock(level),classical=invalid.find(q=>q.book==='kobun400');
  classical.number=100*(level-6)+1;
  eq((await rpc('next',{runId:r.id,questions:invalid},actor)).error.code,'CHALLENGE_INVALID_QUESTION','database rejects classical questions beyond this level\'s section');
 }
 for(let n=0;n<20*level&&['playing','paused'].includes(r.status);n++){
  r=await supply(r,actor);
  // Remove wall-clock test-machine speed from this deterministic combat check.
  await db.query("UPDATE target_private.challenge_runs SET next_attack_at=clock_timestamp()+interval '3 seconds' WHERE id=$1",[r.id]);
  // Reset the minute quota in this fixture; production has no automated answer loop.
  if(n%100===0)await db.query('UPDATE target_private.challenge_rates SET calls=1 WHERE member_id=$1',[actor.memberId]);
  last=await answer(r,true,uid(),actor);ok(last.ok,JSON.stringify(last));r=last.run;
 }
 eq(r.status,'won','normal hits and ten-combo specials defeat the enemy within the old hit limit');
 eq(r.reward,level*100000);return last;
}
async function reconcile(){
 const q=await db.query('SELECT count(*)::int n FROM target_private.profiles p JOIN target_private.wallet_finance_projection(NULL) f USING(member_id) WHERE (p.total_points,p.spent_points,p.casino_net) IS DISTINCT FROM (f.total_points,f.spent_points,f.casino_net)');
 eq(q.rows[0].n,0,'challenge rewards rebuild exactly from shared immutable finance history');
}
async function accounting(){
 const tables=['challenge_runs','challenge_badges','challenge_reward_events','challenge_requests','challenge_rates'];
 const query='SELECT coalesce(sum(bytes),0)::bigint expected FROM ('+tables.map(t=>'SELECT pg_column_size(to_jsonb(t))+128 bytes FROM target_private.'+t+' t').join(' UNION ALL ')+') rows';
 const expected=String(BigInt((await db.query(query)).rows[0].expected)+baselineBytes);
 eq((await db.query('SELECT logical_bytes FROM target_private.system_state WHERE singleton')).rows[0].logical_bytes,expected,'logical quota equals actual retained challenge rows without upsert leakage');
}
async function transitionChecks(migration){
 const {generateQuestions}=require('../server/questions.cjs');
 const originalBlock=level=>[['target1900',5,19],['target1000',3,10],['kobun400',2,4]].flatMap(([book,count,sections])=>
  generateQuestions({book,direction:'japanese',count:10,from:1,to:100*(1+Math.floor((sections-1)*(level-1)/9)),requestId:uid()}).slice(0,count).map(q=>({...q,book})));
 const cases=[
  {level:1,status:'playing',offset:650,invalid:true},
  {level:1,status:'paused',remaining:740,invalid:true},
  {level:7,status:'playing',offset:800,invalid:true},
  {level:8,status:'paused',remaining:600,invalid:true},
  {level:9,status:'playing',offset:900},
  {level:10,status:'paused',remaining:600},
  {level:1,status:'playing',offset:-5000,english:true},
  {level:1,status:'playing',offset:1000,english:true},
  {level:7,status:'paused',remaining:300,empty:true},
  {level:1,status:'aborted',remaining:2000,empty:true}
 ];
 await db.query("INSERT INTO target_private.server_credentials(singleton,key_hash) VALUES(true,encode(sha256(convert_to($1,'UTF8')),'hex'))",[secret]);
 for(const item of cases){
  item.actor={memberId:uid(),name:'Transition '+cases.indexOf(item),sessionHash:crypto.randomBytes(32).toString('hex')};
  await db.query('INSERT INTO target_private.profiles(member_id,name) VALUES($1,$2)',[item.actor.memberId,item.actor.name]);
  let questions=item.empty?[]:originalBlock(item.level);
  if(item.english)questions=questions.filter(q=>q.book!=='kobun400');
  if(item.invalid&&item.level>=7){
   const q=generateQuestions({book:'kobun400',direction:'japanese',count:10,from:201,to:300,requestId:uid()})[0];
   questions[questions.findIndex(q=>q.book==='kobun400')]={...q,book:'kobun400'};
  }
  item.before=(await db.query("INSERT INTO target_private.challenge_runs(member_id,level,status,player_hp,enemy_hp,streak,correct_count,wrong_count,sequence,questions,next_attack_at,attack_remaining_ms) VALUES($1,$2::integer,$3,75,$2::integer*100-5,3,3,1,4,$4,CASE WHEN $5::integer IS NULL THEN NULL ELSE clock_timestamp()+$5*interval '1 millisecond' END,$6) RETURNING to_jsonb(challenge_runs) x",
   [item.actor.memberId,item.level,item.status,JSON.stringify(questions),item.offset??null,item.remaining??1000])).rows[0].x;
 }
 const immutable=(await db.query("SELECT jsonb_build_object('finance',(SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure),'profiles',(SELECT jsonb_agg(to_jsonb(p) ORDER BY member_id) FROM target_private.profiles p),'rewards',(SELECT count(*) FROM target_private.challenge_reward_events),'badges',(SELECT count(*) FROM target_private.challenge_badges),'requests',(SELECT count(*) FROM target_private.challenge_requests)) x")).rows[0].x;
 await db.query(migration);
 eq((await db.query("SELECT jsonb_build_object('finance',(SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure),'profiles',(SELECT jsonb_agg(to_jsonb(p) ORDER BY member_id) FROM target_private.profiles p),'rewards',(SELECT count(*) FROM target_private.challenge_reward_events),'badges',(SELECT count(*) FROM target_private.challenge_badges),'requests',(SELECT count(*) FROM target_private.challenge_requests)) x")).rows[0].x,immutable,'difficulty migration preserves every profile and permanent reward/badge/request receipt');
 for(const item of cases){
  const after=(await db.query('SELECT to_jsonb(r) x FROM target_private.challenge_runs r WHERE id=$1',[item.before.id])).rows[0].x;
  if(item.status==='aborted'){eq(after,item.before,'terminal runs remain byte-for-byte unchanged');continue;}
  const stable=row=>{const {questions,next_attack_at,attack_remaining_ms,updated_at,...rest}=row;return rest;};
  eq(stable(after),stable(item.before),'active transition preserves HP, counters, status, sequence and financial outcomes');
  eq(after.questions,item.invalid?[]:item.before.questions,'only blocks containing out-of-scope classical questions are discarded');
  if(item.offset!==undefined){
   eq((await db.query('SELECT attack_remaining_ms=greatest(0,ceil(extract(epoch FROM ($2::timestamptz-updated_at))*1000)::integer)+1000 same FROM target_private.challenge_runs WHERE id=$1',[after.id,item.before.next_attack_at])).rows[0].same,true,'active remaining time gains exactly one second without old overdue attacks');
  }else eq(after.attack_remaining_ms,item.before.attack_remaining_ms+1000);
  if(item.status==='playing'&&!item.invalid){
   eq((await db.query("SELECT extract(epoch FROM (next_attack_at-greatest($2::timestamptz,updated_at)))*1000 delay FROM target_private.challenge_runs WHERE id=$1",[after.id,item.before.next_attack_at])).rows[0].delay,'1000.000000','valid playing deadline shifts by one second; overdue deadline starts at cutover');
  }else eq(after.next_attack_at,null);
  const resumed=(await rpc('resume',{runId:after.id},item.actor)).run;
  if(item.invalid){
   eq((await rpc('answer',{runId:after.id,questionId:item.before.questions[0].id,choiceId:item.before.questions[0].correctChoiceId},item.actor)).error.code,
    'CHALLENGE_QUESTION_STALE','an unanswered question from a discarded old block cannot be scored');
  }else if(item.before.questions.length){
   eq(resumed.question.id,item.before.questions[0].id,'a retained current question keeps its stable ID');
  }
  const supplied=await supply(resumed,item.actor);
  ok(supplied.question,'both retained and replaced active blocks can continue');
  ok(supplied.question.book!=='kobun400'||(supplied.level>=7&&supplied.question.number<=100*(supplied.level-6)));
  await rpc('abort',{runId:after.id},item.actor);
 }
}
async function legacyCarryChecks(verifySql){
 const {generateQuestions}=require('../server/questions.cjs');
 const actor={memberId:uid(),name:'Retained Study',sessionHash:crypto.randomBytes(32).toString('hex')};
 const study=async(action,params={})=>(await db.query('SELECT public.target_rpc($1,$2,$3::jsonb) x',
  [secret,action,JSON.stringify({memberId:actor.memberId,name:actor.name,...params})])).rows[0].x;
 const beginQuiz=async()=>{
  const questions=generateQuestions({book:'target1900',direction:'japanese',count:10,from:1,to:100,requestId:uid()});
  const value=await study('start',{requestId:uid(),book:'target1900',direction:'japanese',from:1,to:100,questions});
  ok(value.quizId,JSON.stringify(value));return {id:value.quizId,questions};
 };
 const correct=async(quiz,index)=>{
  const q=quiz.questions[index],value=await study('answer',{requestId:uid(),quizId:quiz.id,questionId:q.id,choiceId:q.correctChoiceId});
  eq(value.correct,true);ok(value.awardPoints>0);return value.awardPoints;
 };
 const profile=async()=>(await db.query('SELECT total_points,spent_points,casino_net,correct_count,answered_count,total_points-calculus_points-birthday_points-casino_net-calculus_forgiven_points AS raw_study FROM target_private.profiles WHERE member_id=$1',[actor.memberId])).rows[0];
 const fingerprint=async()=>(await db.query("SELECT encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_array(p.member_id,p.total_points-f.total_points) ORDER BY p.member_id),'[]'::jsonb)::text,'UTF8')),'hex') hash FROM target_private.profiles p JOIN target_private.wallet_finance_projection(NULL) f USING(member_id) WHERE p.total_points>f.total_points")).rows[0].hash;
 const verify=()=>db.query(verifySql);
 const rejectVerification=async(message,update,params=[])=>{
  await db.query('BEGIN');
  try{
   if(update)await db.query(update,params);
   await assert.rejects(verify,/Shared wallet (permanent components|study carry|legacy study carry)/,message);checks++;
  }finally{await db.query('ROLLBACK');}
 };
 const first=await beginQuiz();const firstAward=await correct(first,0),secondAward=await correct(first,1);
 const beforeCleanup=await profile();
 eq((await db.query('SELECT count(*)::int n FROM target_private.answers WHERE quiz_id=$1',[first.id])).rows[0].n,2);
 await db.query("UPDATE target_private.quizzes SET expires_at=clock_timestamp()-interval '9 days' WHERE id=$1",[first.id]);
 const retained=await beginQuiz();
 eq((await db.query('SELECT count(*)::int n FROM target_private.answers WHERE quiz_id=$1',[first.id])).rows[0].n,0,'actual quiz-start retention cleanup prunes old answer details');
 eq(await profile(),beforeCleanup,'actual cleanup preserves lifetime study points and answer counts');
 await correct(retained,0);
 const carry=(await db.query('SELECT p.total_points-f.total_points AS carry FROM target_private.profiles p JOIN target_private.wallet_finance_projection(NULL) f USING(member_id) WHERE p.member_id=$1',[actor.memberId])).rows[0].carry;
 eq(BigInt(carry),BigInt(firstAward+secondAward),'legacy residual equals the real awards removed by cleanup');
 const pin=await fingerprint();
 await db.query("SELECT set_config('target.challenge_legacy_study_carry_sha256','',false)");
 await rejectVerification('positive legacy carry requires an independently reviewed baseline');
 await db.query("SELECT set_config('target.challenge_legacy_study_carry_sha256',$1,false)",[pin]);
 await verify();checks++;
 const before=await profile(),won=await clear(1,actor),after=await profile();
 eq(won.run.status,'won');eq(BigInt(after.total_points)-BigInt(before.total_points),100000n,'challenge adds exact gross income on top of legacy study carry');
 eq(BigInt(after.casino_net)-BigInt(before.casino_net),100000n,'challenge adds exact games component on top of legacy study carry');
 eq(after.spent_points,before.spent_points);eq(after.raw_study,before.raw_study);eq(after.correct_count,before.correct_count);eq(after.answered_count,before.answered_count);
 eq(await fingerprint(),pin,'challenge win leaves each pinned legacy carry unchanged');await verify();checks++;
 // A real purchase gives spending a positive baseline so both signed drift directions are representable.
 const drawn=(await db.query('SELECT public.target_shop_rpc($1,$2,$3::jsonb) x',[secret,'draw',JSON.stringify({memberId:actor.memberId,name:actor.name,requestId:uid(),expectedPrice:100000,expectedCatalogVersion:5,itemType:'frame'})])).rows[0].x;
 ok(!drawn.error,JSON.stringify(drawn));await verify();checks++;
 for(const delta of [100,-100]){
  await rejectVerification('changed positive total-income carry must not hide behind the legacy exception',
   'UPDATE target_private.profiles SET total_points=total_points+$1 WHERE member_id=$2',[delta,actor.memberId]);
 }
 await rejectVerification('negative total-income residual is rejected even with a valid pin',
  'UPDATE target_private.profiles p SET total_points=f.total_points-100 FROM target_private.wallet_finance_projection(NULL) f WHERE p.member_id=f.member_id AND p.member_id=$1',[actor.memberId]);
 await rejectVerification('complete disappearance of the final positive carry must reject the nonempty baseline',
  'UPDATE target_private.profiles p SET total_points=f.total_points FROM target_private.wallet_finance_projection(NULL) f WHERE p.member_id=f.member_id AND p.member_id=$1',[actor.memberId]);
 for(const [column,step,income] of [['spent_points',100,false],['casino_net',100,true],['calculus_points',10000,true],['birthday_points',100000,true],['calculus_forgiven_points',10000,true]]){
  for(const direction of [-1,1]){
   await db.query('BEGIN');
   try{
    let schemaRejected=false;
    try{await db.query('UPDATE target_private.profiles SET '+column+'='+column+'+$1'+(income?',total_points=total_points+$1':'')+' WHERE member_id=$2',[direction*step,actor.memberId]);}
    catch(error){eq(error.code,'23514','unrepresentable component underflow fails at the existing schema boundary');schemaRejected=true;}
    if(!schemaRejected){await assert.rejects(verify,/Shared wallet permanent components do not reconcile/,'all signed non-study/spending drift must reject');checks++;}
   }finally{await db.query('ROLLBACK');}
  }
 }
 await db.query('BEGIN');
 try{
  await db.query('INSERT INTO target_private.profiles(member_id,name,correct_count,answered_count,total_points) VALUES($1,$2,1,1,100)',[uid(),'Unreviewed Carry']);
  await assert.rejects(verify,/legacy study carry differs/,'a new positive member/carry pair cannot reuse the old aggregate baseline');checks++;
 }finally{await db.query('ROLLBACK');}
 await verify();checks++;
}
async function httpChecks(databaseUrl){
 const http=require('node:http'),store=require('../server/store.cjs');
 const {handler}=require('../server/router.cjs');
 const token=crypto.randomBytes(32).toString('base64url'),expired=crypto.randomBytes(32).toString('base64url');
 const cookieSecret=crypto.randomBytes(40).toString('hex'),integrationSecret=crypto.randomBytes(40).toString('hex');
 let verifies=0,rpcCalls=0,identityServer,apiServer;
 const originalRpc=store.rpc,originalChallenge=store.challengeRpc;
 store.rpc=(...args)=>{rpcCalls++;return originalRpc(...args);};
 store.challengeRpc=(...args)=>{rpcCalls++;return originalChallenge(...args);};
 const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const close=server=>new Promise(resolve=>server?server.close(resolve):resolve());
 try{
  identityServer=http.createServer(async(req,res)=>{
   let raw='';for await(const chunk of req)raw+=chunk;verifies++;
   eq(req.url,'/api/integrations/target/verify');eq(req.headers.authorization,'Bearer '+integrationSecret);
   const submitted=JSON.parse(raw);eq(Object.keys(submitted),['token']);
   res.setHeader('Content-Type','application/json');
   if(submitted.token!==token){res.statusCode=401;res.end(JSON.stringify({error:{code:'SESSION_EXPIRED'}}));return;}
   res.end(JSON.stringify({member:{id:stranger.memberId,name:stranger.name},expiresAt:new Date(Date.now()+3600000).toISOString()}));
  });await listen(identityServer);
  process.env.NODE_ENV='test';process.env.VERCEL='';process.env.TARGET_DATABASE_URL=databaseUrl;
  process.env.TARGET_RPC_SECRET=secret;process.env.TARGET_COOKIE_SECRET=cookieSecret;process.env.KGS_TARGET_INTEGRATION_SECRET=integrationSecret;
  process.env.KGS_IDENTITY_URL='http://127.0.0.1:'+identityServer.address().port;
  apiServer=http.createServer(handler);await listen(apiServer);
  const origin='http://127.0.0.1:'+apiServer.address().port;process.env.TARGET_ALLOWED_ORIGINS=origin;
  async function request(route,{body,origin:from=origin,session=token}={},expectedVerifies=1){
   const before=verifies;
   const response=await fetch(origin+route,{method:body===undefined?'GET':'POST',headers:{Cookie:'target_session='+session,...(body===undefined?{}:{Origin:from,'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
   const text=await response.text(),data=JSON.parse(text);
   eq(verifies-before,expectedVerifies,'every supported challenge read/mutation revalidates KGS identity');
   ok(/private/.test(response.headers.get('cache-control'))&&/no-store/.test(response.headers.get('cache-control')));
   ok(!text.includes('correctChoiceId')&&!text.includes('correctText'),'HTTP never exposes private answer keys');
   for(const key of [secret,cookieSecret,integrationSecret])ok(!text.includes(key));
   return {status:response.status,data};
  }
  eq((await request('/api/challenge/map')).status,200);
  let before=rpcCalls;
  eq((await request('/api/challenge/start',{body:{requestId:uid(),level:1},origin:'https://attacker.invalid'},0)).status,403);
  eq(rpcCalls,before,'rejected Origin reaches no database RPC');
  eq((await request('/api/challenge/map',{session:expired})).status,401);eq(rpcCalls,before,'expired KGS cookie reaches no database RPC');
  eq((await request('/api/challenge/next',{body:{runId:uid(),questions:questionBlock(1)}},0)).status,404);eq(rpcCalls,before,'client cannot submit private next-question batches');
  eq((await request('/api/challenge/start',{body:{requestId:uid(),level:1,memberId:member.memberId}})).status,400);eq(rpcCalls,before,'client-chosen actor IDs are rejected before database access');
  for(const route of ['/api/challenge/map?x=1','/api/challenge/map?route=challenge/map&route=challenge/map','/api/challenge/state?runId='+uid()+'&runId='+uid(),'/api/challenge/map?path=ranking']){
   eq((await request(route)).status,400);eq(rpcCalls,before,'invalid/repeated query keys reach no database RPC');
  }
  let value=await request('/api/index?route=challenge/start&path=challenge/start',{body:{requestId:uid(),level:1}});
  eq(value.status,200);let run=value.data.run;ok(run.question,'real router and real DB supply the first private question');
  value=await request('/api/index?route=challenge/state&path=challenge/state&runId='+run.id);eq(value.status,200);eq(value.data.run.question.id,run.question.id);
  value=await request('/api/challenge/pause',{body:{requestId:uid(),runId:run.id}});eq(value.data.run.status,'paused');eq(value.data.run.question,null);ok(!JSON.stringify(value.data).includes('choices'),'paused HTTP result contains no question choices');
  value=await request('/api/challenge/state?runId='+run.id);eq(value.data.run.question,null);
  value=await request('/api/challenge/resume',{body:{requestId:uid(),runId:run.id}});eq(value.data.run.question.id,run.question.id);run=value.data.run;
  let submitted;
  for(let n=0;n<20&&['playing','paused'].includes(run.status);n++){
   if(run.status==='paused')run=(await request('/api/challenge/resume',{body:{requestId:uid(),runId:run.id,specialRequestId:submitted.requestId}})).data.run;
   const privateQ=(await db.query('SELECT questions->0 q FROM target_private.challenge_runs WHERE id=$1',[run.id])).rows[0].q;
   submitted={requestId:uid(),runId:run.id,questionId:privateQ.id,choiceId:privateQ.correctChoiceId};
   value=await request('/api/challenge/answer',{body:submitted});eq(value.status,200);eq(value.data.answer.correct,true);run=value.data.run;
  }
  eq(run.status,'won');eq(value.data.reward,100000);eq(value.data.wallet.totalIncome,100000);eq(value.data.wallet.balance,100000);eq(value.data.wallet.walletRevision,1);
  const replay=await request('/api/challenge/answer',{body:submitted});eq(replay.data.replayed,true);eq(replay.data.wallet,value.data.wallet,'winning HTTP retry uses current shared wallet without paying twice');
  const map=(await request('/api/challenge/map')).data;
  ok(map.levels[0].clearers.includes(stranger.name));ok(!JSON.stringify(map).includes(stranger.memberId),'clearer map emits names without private member IDs');eq(map.levels[1].unlocked,true);
 }finally{
  store.rpc=originalRpc;store.challengeRpc=originalChallenge;
  await close(apiServer);await close(identityServer);await store.closeStore();
 }
}
async function main(){
 eq(process.env.NODE_ENV,'test');
 const url=new URL(process.env.DATABASE_URL||'');
 ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&!url.search&&!url.hash,'localhost fixture only');
 const adminUrl=new URL(url);adminUrl.pathname='/postgres';admin=new Client({connectionString:adminUrl.href});await admin.connect();
 await admin.query('CREATE DATABASE "'+dbName+'"');created=true;
 url.pathname='/'+dbName;db=new Client({connectionString:url.href});other=new Client({connectionString:url.href});await db.connect();await other.connect();
 await db.query("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF; END $$");
 for(const file of (await fs.readdir(path.join(root,'supabase/migrations'))).filter(x=>/^\d+_.*\.sql$/.test(x)).sort()){
  const migration=await fs.readFile(path.join(root,'supabase/migrations',file),'utf8');
  if(file==='20261115092352_target_challenge_gentler_clock_and_late_kobun.sql')await transitionChecks(migration);
  else await db.query(migration);
 }
 const existingBytes=(await db.query("SELECT coalesce(sum(bytes),0)::bigint bytes FROM (SELECT pg_column_size(to_jsonb(t))+128 bytes FROM target_private.challenge_runs t UNION ALL SELECT pg_column_size(to_jsonb(t))+128 FROM target_private.challenge_rates t UNION ALL SELECT pg_column_size(to_jsonb(t))+128 FROM target_private.challenge_requests t) retained")).rows[0].bytes;
 baselineBytes=BigInt((await db.query('SELECT logical_bytes FROM target_private.system_state WHERE singleton')).rows[0].logical_bytes)-BigInt(existingBytes);
 await db.query("INSERT INTO target_private.server_credentials(singleton,key_hash) VALUES(true,encode(sha256(convert_to($1,'UTF8')),'hex')) ON CONFLICT(singleton) DO NOTHING",[secret]);
 for(const actor of [member,stranger])await db.query('INSERT INTO target_private.profiles(member_id,name) VALUES($1,$2)',[actor.memberId,actor.name]);
 eq((await rpc('map',{},member,db,'wrong')).error.code,'RPC_FORBIDDEN');
 eq((await rpc('start',{level:2})).error.code,'CHALLENGE_LOCKED');
 let map=await rpc('map');eq(map.levels.filter(x=>x.unlocked).map(x=>x.level),[1]);eq(map.activeRun,null);
 eq(map.levels.map(row=>row.attackIntervalMs),Array(10).fill(3000));
 for(let n=0;n<20;n++)await rpc('map');await accounting();
 for(let level=1;level<=10;level++){
  const block=questionBlock(level);
  eq(block.length,level<7?8:10);
  for(const [book,count,sections] of [['target1900',5,19],['target1000',3,10],['kobun400',2,4]]){
   eq(block.filter(q=>q.book===book).length,book==='kobun400'&&level<7?0:count);
   const maxSection=book==='kobun400'?level-6:1+Math.floor((sections-1)*(level-1)/9);
   ok(block.filter(q=>q.book===book).every(q=>q.number>=1&&q.number<=maxSection*100));
  }
 }
 const requestId=uid();let result=await rpc('start',{level:1,requestId});let r=result.run;
 eq((await rpc('start',{level:1,requestId})).run.id,r.id,'start replay cannot create another run');
 eq((await rpc('start',{level:2,requestId})).error.code,'CHALLENGE_REQUEST_CONFLICT');
 eq((await rpc('start',{level:1})).error.code,'CHALLENGE_ACTIVE_RUN');
 eq((await rpc('state',{runId:r.id},stranger)).error.code,'CHALLENGE_NOT_FOUND');
 eq(r.playerMaxHp,100);eq(r.enemyMaxHp,100);eq(r.attackIntervalMs,3000);eq(r.attackDamage,5);
 eq((await rpc('next',{runId:r.id,questions:questionBlock(7)})).error.code,'CHALLENGE_INVALID_QUESTION','database rejects the old ten-question classical mix below level 7');
 const earlyInvalid=questionBlock(1);earlyInvalid[0]=questionBlock(7).find(q=>q.book==='kobun400');
 eq((await rpc('next',{runId:r.id,questions:earlyInvalid})).error.code,'CHALLENGE_INVALID_QUESTION','database rejects classical Japanese even inside an eight-question early block');
 r=await supply(r);ok(r.question);ok(!JSON.stringify(r).includes('correctChoiceId')&&!JSON.stringify(r).includes('correctText'));
 const initialQuestion=r.question.id;
 eq((await rpc('next',{runId:r.id,questions:questionBlock(1)})).run.question.id,initialQuestion,'polling cannot replace question');
 eq((await rpc('answer',{runId:r.id,questionId:uid(),choiceId:uid()})).error.code,'CHALLENGE_QUESTION_STALE');
 result=await answer(r,false);r=result.run;eq(result.answer.enemyHealedHp,0);eq(r.playerHp,90);eq(r.enemyHp,100);eq(r.streak,0);
 for(let n=0;n<5;n++){result=await answer(r);r=result.run;}
 eq(result.answer.streakBonus,true);eq(result.answer.healedHp,10);eq(r.playerHp,100);eq(r.enemyHp,75);eq(r.streak,5);
 const missId=uid();result=await answer(r,false,missId);r=result.run;
 eq(r.playerHp,90);eq(r.enemyHp,85);eq(r.streak,0);eq(result.answer.enemyHealedHp,10);
 // The request hash binds the original submitted question and choice, not the next question.
 const saved=(await db.query('SELECT response FROM target_private.challenge_requests WHERE member_id=$1 AND request_id=$2',[member.memberId,missId])).rows[0];ok(saved.response.answer);
 await db.query("UPDATE target_private.challenge_runs SET next_attack_at=clock_timestamp()-interval '6100 milliseconds' WHERE id=$1",[r.id]);
 r=(await rpc('state',{runId:r.id})).run;eq(r.playerHp,75,'all three elapsed enemy attacks apply at the slower interval');ok(r.nextAttackInMs>2500&&r.nextAttackInMs<=3000);
 const pauseId=uid();r=(await rpc('pause',{runId:r.id,requestId:pauseId})).run;
 eq(r.status,'paused');eq(r.question,null);const frozen=r.playerHp,remaining=r.nextAttackInMs;
 await db.query('SELECT pg_sleep(0.04)');r=(await rpc('state',{runId:r.id})).run;
 eq(r.playerHp,frozen);eq(r.nextAttackInMs,remaining,'pause freezes fractional attack interval');eq(r.question,null);
 r=(await rpc('resume',{runId:r.id})).run;eq(r.status,'playing');ok(r.question);ok(r.nextAttackInMs<=remaining);
 eq((await rpc('pause',{runId:r.id,requestId:pauseId})).run.status,'playing','old pause replay never pauses a resumed game');
 await rpc('abort',{runId:r.id});eq((await rpc('abort',{runId:r.id})).run.status,'aborted');
 const starts=await Promise.all([rpc('start',{level:1},member,db),rpc('start',{level:1},member,other)]);
 eq(starts.filter(x=>x.ok).length,1,'cross-connection start race creates one active run');
 r=await supply(starts.find(x=>x.ok).run);
 await db.query("UPDATE target_private.challenge_runs SET next_attack_at=clock_timestamp()-interval '1 hour' WHERE id=$1",[r.id]);
 result=await answer(r);eq(result.run.status,'lost');eq(result.run.playerHp,0);eq(result.run.reward,0);
 eq((await db.query('SELECT count(*)::int n FROM target_private.challenge_reward_events')).rows[0].n,0,'late answer cannot forge a win');
 for(let level=1;level<=10;level++){
  result=await clear(level);eq(result.badgeAwarded,true);await reconcile();
  map=await rpc('map');eq(map.levels[level-1].cleared,true);
  if(level<10)eq(map.levels[level].unlocked,true);
 }
 eq(result.run.playerMaxHp,550);eq(result.run.enemyMaxHp,1000);eq(result.run.attackIntervalMs,3000);eq(result.run.attackDamage,15);
 const earnedBefore=result.wallet.totalIncome,revisionBefore=result.wallet.walletRevision;
 result=await clear(1);eq(result.badgeAwarded,false);eq(result.wallet.totalIncome,earnedBefore+100000);eq(result.wallet.balance,result.wallet.totalIncome);
 eq(result.wallet.walletRevision,revisionBefore+1,'reward advances shared wallet revision exactly once');
 eq((await db.query('SELECT count(*)::int n FROM target_private.challenge_badges WHERE member_id=$1',[member.memberId])).rows[0].n,10);
 eq((await db.query('SELECT count(*)::int n FROM target_private.challenge_reward_events WHERE member_id=$1',[member.memberId])).rows[0].n,11,'repeated clears each receive their own immutable reward');
 await reconcile();
 await accounting();
 // Retry the exact last correct hit on an already won run, including concurrent delivery.
 const replays=await Promise.all([rpc('answer',lastAnswerInput,member,db),rpc('answer',lastAnswerInput,member,other)]);
 for(const replay of replays){eq(replay.replayed,true);eq(replay.run.id,result.run.id);eq(replay.wallet.totalIncome,result.wallet.totalIncome);eq(replay.wallet.walletRevision,result.wallet.walletRevision);}
 eq((await db.query('SELECT count(*)::int n FROM target_private.challenge_reward_events WHERE run_id=$1',[result.run.id])).rows[0].n,1,'concurrent exact winning-answer retries cannot mint a second reward');
 await accounting();
 const lastRequest=(await db.query("SELECT request_id FROM target_private.challenge_requests WHERE run_id=$1 AND action='answer' ORDER BY created_at DESC LIMIT 1",[result.run.id])).rows[0].request_id;
 const hashOnlyReplay=await rpc('answer',{runId:result.run.id,questionId:uid(),choiceId:uid(),requestId:lastRequest});
 eq(hashOnlyReplay.error.code,'CHALLENGE_REQUEST_CONFLICT','request UUID cannot be reused with forged payload');
 await assert.rejects(()=>db.query('DELETE FROM target_private.challenge_reward_events WHERE run_id=$1',[result.run.id]),{code:'42501'});checks++;
 await db.query('SET ROLE anon');
 await assert.rejects(()=>db.query('SELECT * FROM target_private.challenge_runs'),{code:'42501'});checks++;
 await db.query('RESET ROLE');
 // Force capacity failure exactly on the final immutable request receipt, after reward/badge writes.
 r=await start(1);r=await supply(r);
 await db.query('UPDATE target_private.challenge_runs SET enemy_hp=5 WHERE id=$1',[r.id]);
 const walletBefore=(await db.query('SELECT total_points,casino_net,wallet_revision FROM target_private.profiles WHERE member_id=$1',[member.memberId])).rows[0];
 const runBefore=(await db.query('SELECT to_jsonb(r) x FROM target_private.challenge_runs r WHERE id=$1',[r.id])).rows[0].x;
 const receiptBefore=(await db.query('SELECT count(*)::int n FROM target_private.challenge_reward_events')).rows[0].n;
 const used=(await db.query('SELECT logical_bytes FROM target_private.system_state WHERE singleton')).rows[0].logical_bytes;
 await db.query("CREATE FUNCTION target_private.challenge_capacity_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced receipt capacity' USING ERRCODE='54000'; END $$; CREATE TRIGGER challenge_capacity_test BEFORE INSERT ON target_private.challenge_requests FOR EACH ROW EXECUTE FUNCTION target_private.challenge_capacity_test()");
 result=await answer(r);eq(result.error.code,'CAPACITY_LIMIT');
 eq((await db.query('SELECT total_points,casino_net,wallet_revision FROM target_private.profiles WHERE member_id=$1',[member.memberId])).rows[0],walletBefore,'capacity failure rolls wallet fully back');
 eq((await db.query('SELECT to_jsonb(r) x FROM target_private.challenge_runs r WHERE id=$1',[r.id])).rows[0].x,runBefore,'capacity failure rolls win, HP and question consumption back');
 eq((await db.query('SELECT count(*)::int n FROM target_private.challenge_reward_events')).rows[0].n,receiptBefore);
 eq((await db.query('SELECT logical_bytes FROM target_private.system_state WHERE singleton')).rows[0].logical_bytes,used,'capacity failure rolls all accounting back');
 await db.query('DROP TRIGGER challenge_capacity_test ON target_private.challenge_requests; DROP FUNCTION target_private.challenge_capacity_test()');
 await db.query('UPDATE target_private.system_state SET logical_bytes=104857600 WHERE singleton');
 eq((await rpc('pause',{runId:r.id})).error.code,'CAPACITY_LIMIT','actual shared logical budget rejects storage growth');
 await db.query('UPDATE target_private.system_state SET logical_bytes=$1 WHERE singleton',[used]);
 await reconcile();
 await httpChecks(url.href);await reconcile();await accounting();
 const verifySql=await fs.readFile(path.join(root,'supabase/tests/challenge_levels_verify.sql'),'utf8');
 await db.query(verifySql);
 checks++;
 await legacyCarryChecks(verifySql);
 console.log('Challenge PostgreSQL integration checks passed:',checks);
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{
 await Promise.allSettled([db?.end(),other?.end()]);
 if(created&&admin){try{await admin.query('DROP DATABASE "'+dbName+'" WITH (FORCE)')}catch(e){console.error('fixture cleanup failed',e.message);process.exitCode=1;}}
 await admin?.end();
});
