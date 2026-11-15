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
async function start(level=1){const value=await rpc('start',{level});ok(value.ok,JSON.stringify(value));return value.run;}
async function supply(run){
 if(run.status==='playing'&&!run.question){const value=await rpc('next',{runId:run.id,questions:questionBlock(run.level)});ok(value.ok,JSON.stringify(value));return value.run;}
 return run;
}
async function answer(run,correct=true,requestId=uid()){
 run=await supply(run);
 const q=(await db.query('SELECT questions->0 q FROM target_private.challenge_runs WHERE id=$1',[run.id])).rows[0].q;
 const choice=correct?q.correctChoiceId:q.choices.find(c=>c.id!==q.correctChoiceId).id;
 lastAnswerInput={runId:run.id,questionId:q.id,choiceId:choice,requestId};
 return rpc('answer',lastAnswerInput);
}
async function clear(level){
 let r=await start(level),last;
 for(let n=0;n<20*level;n++){
  r=await supply(r);
  // Remove wall-clock test-machine speed from this deterministic combat check.
  await db.query("UPDATE target_private.challenge_runs SET next_attack_at=clock_timestamp()+((CASE WHEN level=10 THEN 1000 ELSE 2000-100*(level-1) END)*interval '1 millisecond') WHERE id=$1",[r.id]);
  // Reset the minute quota in this fixture; production has no automated answer loop.
  if(n%100===0)await db.query('UPDATE target_private.challenge_rates SET calls=1 WHERE member_id=$1',[member.memberId]);
  last=await answer(r);ok(last.ok,JSON.stringify(last));r=last.run;
 }
 eq(r.status,'won','twenty correct hits per level defeats the enemy');
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
  for(let n=0;n<20;n++){
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
 for(const file of (await fs.readdir(path.join(root,'supabase/migrations'))).filter(x=>/^\d+_.*\.sql$/.test(x)).sort())await db.query(await fs.readFile(path.join(root,'supabase/migrations',file),'utf8'));
 baselineBytes=BigInt((await db.query('SELECT logical_bytes FROM target_private.system_state WHERE singleton')).rows[0].logical_bytes);
 await db.query("INSERT INTO target_private.server_credentials(singleton,key_hash) VALUES(true,encode(sha256(convert_to($1,'UTF8')),'hex'))",[secret]);
 for(const actor of [member,stranger])await db.query('INSERT INTO target_private.profiles(member_id,name) VALUES($1,$2)',[actor.memberId,actor.name]);
 eq((await rpc('map',{},member,db,'wrong')).error.code,'RPC_FORBIDDEN');
 eq((await rpc('start',{level:2})).error.code,'CHALLENGE_LOCKED');
 let map=await rpc('map');eq(map.levels.filter(x=>x.unlocked).map(x=>x.level),[1]);eq(map.activeRun,null);
 for(let n=0;n<20;n++)await rpc('map');await accounting();
 for(let level=1;level<=10;level++){
  const block=questionBlock(level);
  for(const [book,count,sections] of [['target1900',5,19],['target1000',3,10],['kobun400',2,4]]){
   eq(block.filter(q=>q.book===book).length,count);
   ok(block.filter(q=>q.book===book).every(q=>q.number>=1&&q.number<=(1+Math.floor((sections-1)*(level-1)/9))*100));
  }
 }
 const requestId=uid();let result=await rpc('start',{level:1,requestId});let r=result.run;
 eq((await rpc('start',{level:1,requestId})).run.id,r.id,'start replay cannot create another run');
 eq((await rpc('start',{level:2,requestId})).error.code,'CHALLENGE_REQUEST_CONFLICT');
 eq((await rpc('start',{level:1})).error.code,'CHALLENGE_ACTIVE_RUN');
 eq((await rpc('state',{runId:r.id},stranger)).error.code,'CHALLENGE_NOT_FOUND');
 eq(r.playerMaxHp,100);eq(r.enemyMaxHp,100);eq(r.attackIntervalMs,2000);eq(r.attackDamage,5);
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
 await db.query("UPDATE target_private.challenge_runs SET next_attack_at=clock_timestamp()-interval '4100 milliseconds' WHERE id=$1",[r.id]);
 r=(await rpc('state',{runId:r.id})).run;eq(r.playerHp,75,'all three elapsed enemy attacks apply');ok(r.nextAttackInMs>1500&&r.nextAttackInMs<=2000);
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
 eq(result.run.playerMaxHp,550);eq(result.run.enemyMaxHp,1000);eq(result.run.attackIntervalMs,1000);eq(result.run.attackDamage,15);
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
 await db.query(await fs.readFile(path.join(root,'supabase/tests/challenge_levels_verify.sql'),'utf8'));
 checks++;
 console.log('Challenge PostgreSQL integration checks passed:',checks);
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{
 await Promise.allSettled([db?.end(),other?.end()]);
 if(created&&admin){try{await admin.query('DROP DATABASE "'+dbName+'" WITH (FORCE)')}catch(e){console.error('fixture cleanup failed',e.message);process.exitCode=1;}}
 await admin?.end();
});
