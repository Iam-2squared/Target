'use strict';
// Independent integration review, only a disposable loopback PostgreSQL database.
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs/promises'),path=require('node:path'),{createRequire}=require('node:module');
const root=path.resolve(__dirname,'..'),requireRepo=createRequire(root+'/package.json'),{Client,Pool}=requireRepo('pg'),{generateQuestions}=requireRepo('./server/questions.cjs');
assert.equal(process.env.NODE_ENV,'test');const source=new URL(process.env.DATABASE_URL||'');assert(['localhost','127.0.0.1','[::1]'].includes(source.hostname));
const dbName='target_mastery_achievements_independent_review',url=new URL(source),adminURL=new URL(source);url.pathname='/'+dbName;adminURL.pathname='/postgres';
const migration='20261109084513_target_section_mastery_achievements.sql',dir=root+'/supabase/migrations',uuid=()=>crypto.randomUUID(),secret=crypto.randomBytes(32).toString('hex'),db=new Pool({connectionString:url.href,max:10});
let checks=0,phases=[];const eq=(a,b,m)=>{checks++;assert.deepEqual(a,b,m);},ok=(v,m)=>{checks++;assert(v,m);};
const person=name=>({memberId:uuid(),name}),a=person('既存100%'),b=person('達成者B'),c=person('古文達成者'),d=person('未達成の人'),e=person('英熟語達成者');
const rpc=(action,input,client=db)=>client.query('SELECT public.target_rpc($1,$2,$3::jsonb) v',[secret,action,JSON.stringify(input)]).then(r=>r.rows[0].v);
const mastery=(p,book='target1900')=>rpc('mastery',{...p,book});
async function seed(p,book,section,finalStreak=1){const lo=(section-1)*100+1;await db.query('INSERT INTO target_private.profiles(member_id,name) VALUES($1,$2) ON CONFLICT(member_id) DO NOTHING',[p.memberId,p.name]);await db.query('INSERT INTO target_private.word_mastery(member_id,book,word_number,correct_streak,needs_review) SELECT $1,$2,n,CASE WHEN n=$3+99 THEN $4 ELSE 2 END,false FROM generate_series($3::integer,$3::integer+99) n',[p.memberId,book,lo,finalStreak]);}
async function quiz(p,book,number){const q=generateQuestions({book,direction:'english',count:10,from:number,to:number,requestId:uuid()});eq(q.length,1);const r=await rpc('start',{...p,requestId:uuid(),book,direction:'english',from:number,to:number,questions:q});ok(!r.error,JSON.stringify(r.error));return{p,q:q[0],r};}
function input(q,correct=true){return{...q.p,quizId:q.r.quizId,questionId:q.q.id,choiceId:correct?q.q.correctChoiceId:q.q.choices.find(x=>x.id!==q.q.correctChoiceId).id,requestId:uuid()};}
async function answer(p,book,number,correct=true){const q=await quiz(p,book,number),i=input(q,correct),r=await rpc('answer',i);ok(!r.error,JSON.stringify(r.error));eq(r.correct,correct);return{i,r};}
async function phase(label,fn){await fn();phases.push(label);console.log('PASS '+label+' / '+checks);}
async function stableRows(){return(await db.query("SELECT jsonb_build_object('profiles',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY member_id),'[]') FROM target_private.profiles p),'words',(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY member_id,book,word_number),'[]') FROM target_private.word_mastery m),'answers',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY quiz_id,question_id),'[]') FROM target_private.answers a),'quizzes',(SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY id),'[]') FROM target_private.quizzes q)) v")).rows[0].v;}
let table;
(async()=>{try{
 const admin=new Client({connectionString:adminURL.href});await admin.connect();try{await admin.query('DROP DATABASE IF EXISTS '+dbName+' WITH (FORCE)');await admin.query('CREATE DATABASE '+dbName);}finally{await admin.end();}
 for(const file of(await fs.readdir(dir)).filter(f=>/^\d+_.*\.sql$/.test(f)&&f<migration).sort())await db.query(await fs.readFile(path.join(dir,file),'utf8'));
 await db.query("INSERT INTO target_private.server_credentials(singleton,key_hash) VALUES(true,encode(sha256(convert_to($1,'UTF8')),'hex'))",[secret]);
 await db.query("CREATE OR REPLACE FUNCTION target_private.reward_points_for_roll(p_roll integer) RETURNS integer LANGUAGE sql IMMUTABLE STRICT SECURITY INVOKER SET search_path=pg_catalog AS 'SELECT 1000'");
 await seed(a,'target1900',1,2);await seed(b,'target1900',2);await seed(c,'kobun400',4);await seed(d,'target1900',19,0);await seed(e,'target1000',10);
 const before=await stableRows(),coreHash=(await db.query("SELECT md5(pg_get_functiondef('public.target_rpc(text,text,jsonb)'::regprocedure)) v")).rows[0].v;
 await phase('failed activation is atomic at exhausted storage capacity',async()=>{
  const original=Number((await db.query('SELECT logical_bytes FROM target_private.system_state WHERE singleton')).rows[0].logical_bytes);await db.query('UPDATE target_private.system_state SET logical_bytes=104857600 WHERE singleton');const client=await db.connect();try{await assert.rejects(client.query(await fs.readFile(path.join(dir,migration),'utf8')),error=>error.code==='P0001');checks++;await client.query('ROLLBACK');}finally{client.release();}
  eq((await db.query("SELECT to_regclass('target_private.section_mastery_achievements') v")).rows[0].v,null);eq((await db.query("SELECT md5(pg_get_functiondef('public.target_rpc(text,text,jsonb)'::regprocedure)) v")).rows[0].v,coreHash);eq(await stableRows(),before);eq(Number((await db.query('SELECT logical_bytes FROM target_private.system_state WHERE singleton')).rows[0].logical_bytes),104857600);await db.query('UPDATE target_private.system_state SET logical_bytes=$1 WHERE singleton',[original]);
 });
 await phase('migration backfills only proven current100 without modifying histories or scorer',async()=>{
  await db.query(await fs.readFile(path.join(dir,migration),'utf8'));eq(await stableRows(),before);eq((await db.query("SELECT md5(pg_get_functiondef('public.target_rpc(text,text,jsonb)'::regprocedure)) v")).rows[0].v,coreHash);
  table=(await db.query("SELECT tablename FROM pg_tables WHERE schemaname='target_private' AND tablename LIKE '%achievement%' ORDER BY tablename")).rows.map(r=>r.tablename).find(n=>/section|mastery/.test(n));ok(table,'private achievement table exists');
  const m=await mastery(d);eq(m.sections[0].achievers.map(x=>[x.memberId,x.name]),[[a.memberId,a.name]]);ok(Number.isFinite(Date.parse(m.sections[0].achievers[0].achievedAt)));eq(m.sections[1].achievers,[]);eq(m.sections[18].achievers,[]);eq(m.sections[0].mastered,0);eq(m.sections[18].mastered,99);
 });
 let first;
 await phase('real accepted final-word answers create permanent achievements across every book',async()=>{
  first=await answer(b,'target1900',200);let m=await mastery(d);eq(m.sections[1].achievers.map(x=>x.memberId),[b.memberId]);eq(m.sections[0].achievers.map(x=>x.memberId),[a.memberId]);eq(m.sections[2].achievers,[]);
  await answer(c,'kobun400',400);await answer(e,'target1000',1000);for(const[p,book,s]of[[c,'kobun400',4],[e,'target1000',10]]){const x=await mastery(d,book);eq(x.sections[s-1].achievers.map(v=>v.memberId),[p.memberId]);eq(x.sections.length,book==='kobun400'?4:10);ok(x.sections.filter((_,i)=>i!==s-1).every(r=>r.achievers.length===0));}
 });
 let firstAchiever;
 await phase('misses never revoke achievement and two-success relearning never duplicates it',async()=>{
  firstAchiever=(await mastery(d)).sections[1].achievers[0];await answer(b,'target1900',200,false);let m=await mastery(b);eq(m.sections[1].mastered,99);eq(m.reviewNumbers,[200]);eq(m.sections[1].achievers,[firstAchiever]);eq((await mastery(d)).reviewNumbers,[]);
  await answer(b,'target1900',200);eq((await mastery(b)).sections[1].mastered,99);await answer(b,'target1900',200);m=await mastery(b);eq(m.sections[1].mastered,100);eq(m.reviewNumbers,[]);eq(m.sections[1].achievers,[firstAchiever]);
  eq(await rpc('answer',first.i),first.r);eq(await rpc('answer',{...first.i,requestId:uuid()}),first.r);eq((await mastery(b)).sections[1].achievers,[firstAchiever]);
 });
 await phase('current verified username is joined rather than frozen in achievement',async()=>{
  b.name='新しい名前<&>';await rpc('profile',b);const row=(await mastery(d)).sections[1].achievers[0];eq(row.name,b.name);eq(row.memberId,b.memberId);eq(row.achievedAt,firstAchiever.achievedAt);eq(Object.keys(row).sort(),['achievedAt','memberId','name']);
 });
 await phase('concurrent accepted completions and retries create one durable first achievement',async()=>{
  const p=person('並列完了');await seed(p,'kobun400',1,1);const q1=await quiz(p,'kobun400',100),q2=await quiz(p,'kobun400',100),i1=input(q1),i2=input(q2);const results=await Promise.all(Array.from({length:16},(_,n)=>rpc('answer',n%2?i1:i2)));for(const r of results)ok(!r.error);const rows=(await mastery(d,'kobun400')).sections[0].achievers;eq(rows.map(x=>x.memberId),[p.memberId]);const stored=await db.query('SELECT count(*)::integer n FROM target_private.'+table+' WHERE member_id=$1',[p.memberId]);eq(stored.rows[0].n,1);
 });
 await phase('reward-locked zero-point answer still establishes learning mastery and100%',async()=>{
  const p=person('無加点定着');await seed(p,'target1900',3,1);await db.query('UPDATE target_private.profiles SET reward_locked=true,reward_miss_streak=2,reward_correct_streak=0 WHERE member_id=$1',[p.memberId]);const r=await answer(p,'target1900',300);eq(r.r.awardPoints,0);eq(r.r.rewardLock,{locked:true,missStreak:2,recoveryStreak:1});eq((await mastery(d)).sections[2].achievers.map(x=>x.memberId),[p.memberId]);
 });
 await phase('rollback erases unfinished achievements and preserves first accepted transaction only',async()=>{
  const p=person('ロールバック');await seed(p,'target1900',4,1);const q=await quiz(p,'target1900',400),i=input(q),client=await db.connect();try{await client.query('BEGIN');const r=await rpc('answer',i,client);ok(!r.error);ok((await client.query('SELECT count(*)::integer n FROM target_private.'+table+' WHERE member_id=$1',[p.memberId])).rows[0].n===1);await client.query('ROLLBACK');}finally{client.release();}eq((await mastery(d)).sections[3].achievers,[]);const accepted=await rpc('answer',i);ok(!accepted.error);eq((await mastery(d)).sections[3].achievers.map(x=>x.memberId),[p.memberId]);
 });
 await phase('capacity includes pending answer and achievement and rejects atomic completion one byte above ceiling',async()=>{
  const p=person('容量境界'),qbook='target1900';await seed(p,qbook,5,1);const q=await quiz(p,qbook,500),i=input(q),client=await db.connect();let answerBytes,achievementBytes;
  const logical=async c=>Number((await c.query('SELECT logical_bytes FROM target_private.system_state WHERE singleton')).rows[0].logical_bytes);
  try{await client.query('BEGIN');const lo=await logical(client),r=await rpc('answer',i,client);ok(!r.error);answerBytes=Number((await client.query('SELECT charged_bytes FROM target_private.answers WHERE quiz_id=$1 AND question_id=$2',[i.quizId,i.questionId])).rows[0].charged_bytes);achievementBytes=(await logical(client))-lo-answerBytes;ok(achievementBytes>0,'new permanent achievement has charged storage');await client.query('ROLLBACK');}finally{client.release();}
  const original=await logical(db),over=104857600-answerBytes-achievementBytes+1;await db.query('UPDATE target_private.system_state SET logical_bytes=$1 WHERE singleton',[over]);const prior=await stableRows(),bad=await rpc('answer',i);eq(bad.error?.code,'CAPACITY_LIMIT');eq(await stableRows(),prior,'rejected achievement rolls back mastery, answer, counters and profile');eq(await logical(db),over);eq((await mastery(d)).sections[4].achievers,[]);
  await db.query('UPDATE target_private.system_state SET logical_bytes=$1 WHERE singleton',[over-1]);const good=await rpc('answer',i);ok(!good.error,JSON.stringify(good.error));eq(await logical(db),104857600,'exact pendinganswer+achievement boundary accepts');eq((await mastery(d)).sections[4].achievers.map(x=>x.memberId),[p.memberId]);await db.query('UPDATE target_private.system_state SET logical_bytes=$1 WHERE singleton',[original+answerBytes+achievementBytes]);
 });
 await phase('expired quiz deletion cannot cascade away permanent achievements',async()=>{
  const client=await db.connect();try{await client.query('BEGIN');await client.query('DELETE FROM target_private.quizzes WHERE member_id=$1',[c.memberId]);eq((await client.query('SELECT count(*)::integer n FROM target_private.'+table+' WHERE member_id=$1',[c.memberId])).rows[0].n,1);const snapshot=(await client.query('SELECT target_private.mastery_snapshot($1,$2) v',[d.memberId,'kobun400'])).rows[0].v;eq(snapshot.sections[3].achievers.map(x=>x.memberId),[c.memberId]);await client.query('ROLLBACK');}finally{client.release();}
 });
 await phase('invalid material and Section identities are rejected by private table constraints',async()=>{
  for(const[book,section]of[['invalid',1],['target1900',20],['target1000',11],['kobun400',5],['target1900',0]]){await assert.rejects(db.query('INSERT INTO target_private.'+table+"(member_id,book,section,recorded_from) VALUES($1,$2,$3,'answer')",[d.memberId,book,section]),error=>error.code==='23514');checks++;}
  await assert.rejects(db.query('INSERT INTO target_private.'+table+"(member_id,book,section,recorded_from) VALUES($1,'target1900',1,'answer')",[uuid()]),error=>error.code==='23503');checks++;
 });
 await phase('private table/function privileges and invalid requests preserve privacy',async()=>{
  const attrs=(await db.query("SELECT relrowsecurity,has_table_privilege('anon',$1,'SELECT') anon,has_table_privilege('authenticated',$1,'SELECT') authenticated FROM pg_class WHERE oid=$1::regclass",['target_private.'+table])).rows[0];eq(attrs,{relrowsecurity:true,anon:false,authenticated:false});
  const absent=await rpc('mastery',{...d,book:'invalid'});eq(absent.error.code,'INVALID_REQUEST');const badSecret=(await db.query('SELECT public.target_rpc($1,$2,$3::jsonb) v',['bad','mastery',JSON.stringify({...d,book:'target1900'})])).rows[0].v;ok(badSecret.error);ok(!JSON.stringify(badSecret).includes(a.name));
 });
 await fs.mkdir(path.join(root,'artifacts'),{recursive:true});const report={status:'passed',checks,phases,hostedWrites:0,productEdits:0,database:dbName};await fs.writeFile((process.env.MASTERY_ACHIEVEMENTS_REPORT||path.join(root,'artifacts/section-mastery-achievements-db-results.json')),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
 }catch(e){console.error(String(e.stack||e).replaceAll(secret,'[redacted]'));await fs.mkdir(path.join(root,'artifacts'),{recursive:true});await fs.writeFile((process.env.MASTERY_ACHIEVEMENTS_REPORT||path.join(root,'artifacts/section-mastery-achievements-db-results.json')),JSON.stringify({status:'failed',checks,phases,error:String(e.message).replaceAll(secret,'[redacted]')},null,2)+'\n');process.exitCode=1;}finally{await db.end();}})();
