'use strict';
// Real PostgreSQL only. All identities and score changes are synthetic and
// limited to this freshly recreated, loopback-only test database.
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs/promises'),path=require('node:path');
const {Client,Pool}=require('pg');
const {generateQuestions}=require('../server/questions.cjs');
const root=path.resolve(__dirname,'..'),source=new URL(process.env.DATABASE_URL||'');
assert.equal(process.env.NODE_ENV,'test');assert(['localhost','127.0.0.1','[::1]'].includes(source.hostname));source.pathname='/target_bonus_test';
const db=new Pool({connectionString:source.href,max:8}),uuid=()=>crypto.randomUUID(),secret=crypto.randomBytes(32).toString('base64url');
const duration=15900,migration='20261106083226_target_hundred_thousand_bonus.sql';
let checks=0,phase='setup',passed=false;
const eq=(a,b,label)=>{checks++;assert.deepEqual(a,b,label);},ok=(value,label)=>{checks++;assert(value,label);};
const person=name=>({memberId:uuid(),name}),a=person('時限確認A'),b=person('時限確認B'),c=person('容量確認C');
const rpc=(action,input,key=secret)=>db.query('SELECT public.target_rpc($1,$2,$3::jsonb) AS value',[key,action,JSON.stringify(input)]).then(r=>r.rows[0].value);
const shop=(action,input)=>db.query('SELECT public.target_shop_rpc($1,$2,$3::jsonb) AS value',[secret,action,JSON.stringify(input)]).then(r=>r.rows[0].value);
const profile=m=>rpc('profile',m);
const definition=name=>db.query('SELECT pg_get_functiondef($1::regprocedure) AS source',[name]).then(r=>r.rows[0].source);
async function start(m,count=10){const questions=generateQuestions({book:'target1900',direction:'english',count,from:1,to:count,requestId:uuid()}),value=await rpc('start',{...m,requestId:uuid(),book:'target1900',direction:'english',from:1,to:count,questions});ok(!value.error,'Actual quiz starts');return{value,questions};}
function answer(m,quiz,index,correct=true,requestId=uuid()){const q=quiz.questions[index];return{...m,quizId:quiz.value.quizId,questionId:q.id,choiceId:correct?q.correctChoiceId:q.choices.find(v=>v.id!==q.correctChoiceId).id,requestId};}
async function forceAward(points){await db.query(`CREATE OR REPLACE FUNCTION target_private.reward_points_for_roll(p_roll integer) RETURNS integer LANGUAGE sql IMMUTABLE STRICT SECURITY INVOKER SET search_path=pg_catalog AS 'SELECT CASE WHEN p_roll BETWEEN 0 AND 99 THEN ${points} ELSE NULL END'`);}
async function rows(){return(await db.query('SELECT member_id,name,total_points,correct_count,answered_count,spent_points,updated_at FROM target_private.profiles ORDER BY member_id')).rows;}
(async()=>{
 try{
  const adminURL=new URL(source.href);adminURL.pathname='/postgres';const admin=new Client({connectionString:adminURL.href});await admin.connect();try{await admin.query('DROP DATABASE IF EXISTS target_bonus_test WITH (FORCE)');await admin.query('CREATE DATABASE target_bonus_test');}finally{await admin.end();}
  const migrations=(await fs.readdir(path.join(root,'supabase/migrations'))).filter(n=>/^\d+_.*\.sql$/.test(n)).sort();
  // Build the actual pre-bonus database first. Later migrations may depend on
  // the bonus RPC, and must not be applied out of chronological order.
  for(const file of migrations.filter(n=>n<migration))await db.query(await fs.readFile(path.join(root,'supabase/migrations',file),'utf8'));
  await db.query("INSERT INTO target_private.server_credentials(singleton,key_hash) VALUES(true,encode(sha256(convert_to($1,'UTF8')),'hex'))",[secret]);
  await db.query('INSERT INTO target_private.profiles(member_id,name,total_points,correct_count,answered_count) VALUES($1,$2,100000,10,10)',[a.memberId,a.name]);
  const oldShop=await definition('public.target_shop_rpc(text,text,jsonb)'),oldOdds=await definition('target_private.reward_points_for_roll(integer)');
  const purchaseRequest=uuid(),purchase=await shop('draw',{...a,requestId:purchaseRequest});ok(!purchase.error,'Historical purchase succeeds');
  await forceAward(100);const legacyQuiz=await start(a),legacyInput=answer(a,legacyQuiz,0),legacyReceipt=await rpc('answer',legacyInput);await db.query(oldOdds);
  const before=await rows(),answersBefore=(await db.query('SELECT * FROM target_private.answers ORDER BY quiz_id,question_id')).rows,drawsBefore=(await db.query('SELECT * FROM target_private.sticker_draws ORDER BY member_id,request_id')).rows;
  phase='migration';await db.query(await fs.readFile(path.join(root,'supabase/migrations',migration),'utf8'));
  eq(await rows(),before,'Migration preserves income, counts, spending and ranking dates');eq((await db.query('SELECT * FROM target_private.answers ORDER BY quiz_id,question_id')).rows,answersBefore,'Historical answers are untouched');eq((await db.query('SELECT * FROM target_private.sticker_draws ORDER BY member_id,request_id')).rows,drawsBefore,'Historical purchases are untouched');eq(await definition('public.target_shop_rpc(text,text,jsonb)'),oldShop,'Wallet RPC is unchanged');
  // Exercise the bonus against today's complete schema after independently
  // proving that its own migration did not rewrite historical state.
  for(const file of migrations.filter(n=>n>migration))await db.query(await fs.readFile(path.join(root,'supabase/migrations',file),'utf8'));
  const currentWallet=await shop('wallet',a);eq(currentWallet.price,100000,'Latest schema advertises100k for new purchases');
  const historicalReplay=await shop('draw',{...a,requestId:purchaseRequest,expectedPrice:10000});eq(historicalReplay.cost,10000,'A historical purchase retains its original10k cost');eq(historicalReplay.spent,10000,'Replaying an old purchase never adds spending');
  const normalOdds=await definition('target_private.reward_points_for_roll(integer)');
  const map=(await db.query('SELECT roll,target_private.reward_points_for_roll(roll) AS award FROM generate_series(0,99) roll ORDER BY roll')).rows;
  eq(map.map(r=>r.award),Array.from({length:100},(_,roll)=>roll===0?100000:roll<=2?10000:roll<=17?1000:100),'Exactly 1/2/15/82 of a hundred outcomes');
  eq((await db.query('SELECT target_private.reward_points_for_roll(-1) AS a,target_private.reward_points_for_roll(100) AS b,target_private.reward_points_for_roll(NULL) AS c')).rows[0],{a:null,b:null,c:null});
  eq(await rpc('answer',legacyInput),legacyReceipt,'Legacy receipt replay remains byte-equivalent JSON');eq((await profile(a)).bonus,null,'Legacy receipt never starts a bonus');
  const authCounts=(await db.query('SELECT count(*)::int AS n FROM target_private.profiles')).rows[0].n;
  eq((await rpc('profile',person('拒否'),'wrong-credential')).error.code,'RPC_FORBIDDEN');eq((await db.query('SELECT count(*)::int AS n FROM target_private.profiles')).rows[0].n,authCounts,'Wrong credential allocates no member');
  phase='first jackpot';await forceAward(100000);const quiz=await start(a),firstInput=answer(a,quiz,0),first=await rpc('answer',firstInput);
  eq(first.awardPoints,100000);ok(first.correct&&first.bonus,'100000 creates an accepted server bonus');eq(first.bonus.durationMs,duration);eq(Date.parse(first.bonus.endsAt)-Date.parse(first.bonus.startedAt),duration,'Fixed absolute duration');ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(first.bonus.endsAt),'Safari-safe UTC milliseconds');
  eq(await rpc('answer',firstInput),first,'Same-ID replay never redraws or extends');eq(await rpc('answer',{...firstInput,requestId:uuid()}),first,'Alternate-ID replay preserves original window');
  eq((await profile(a)).bonus,first.bonus);const another=await start(a);eq(another.value.bonus,first.bonus,'Another quiz shares the member window');
  const wrong=await rpc('answer',answer(a,quiz,1,false));eq(wrong.awardPoints,0);eq(wrong.bonus,first.bonus,'Wrong answers cannot extend the bonus');
  await db.query("CREATE OR REPLACE FUNCTION target_private.reward_points_for_roll(p_roll integer) RETURNS integer LANGUAGE plpgsql IMMUTABLE STRICT SECURITY INVOKER SET search_path=pg_catalog AS $$ BEGIN RAISE EXCEPTION 'Bonus branch must not draw'; END $$");
  const simultaneous=await Promise.all([rpc('answer',answer(a,quiz,2)),rpc('answer',answer(a,another,0))]);
  for(const result of simultaneous){eq(result.awardPoints,500,'Every new correct bonus answer is 500');eq(result.bonus,first.bonus,'Concurrent correct answers keep one fixed window');}
  const bQuiz=await start(b);eq((await profile(b)).bonus,null,'Other members do not inherit a bonus');await forceAward(100);const ordinary=await rpc('answer',answer(b,bQuiz,0));eq(ordinary.awardPoints,100);eq(ordinary.bonus,null);
  eq((await rpc('answer',{...answer(a,quiz,3),bonusEndsAt:'2099-01-01T00:00:00Z'})).error.code,'INVALID_REQUEST','Client-supplied time is not accepted');
  phase='quota';const cQuiz=await start(c),beforeC=await profile(c),usage=(await db.query('SELECT logical_bytes FROM target_private.system_state WHERE singleton')).rows[0].logical_bytes;
  await forceAward(100000);await db.query('UPDATE target_private.system_state SET logical_bytes=104857600 WHERE singleton');
  const rejected=await rpc('answer',answer(c,cQuiz,0));eq(rejected.error.code,'CAPACITY_LIMIT');eq(await profile(c),beforeC,'A rejected jackpot grants neither money nor a window');await db.query('UPDATE target_private.system_state SET logical_bytes=$1 WHERE singleton',[usage]);
  await forceAward(100);
  phase='expiry queued behind real lock';const lock=await db.connect();let queued;
  try{await lock.query('BEGIN');await lock.query('SELECT pg_advisory_xact_lock(991101)');queued=rpc('answer',answer(a,quiz,3));const remaining=Date.parse(first.bonus.endsAt)-Date.now();await new Promise(resolve=>setTimeout(resolve,Math.max(80,remaining+80)));await lock.query('COMMIT');}catch(error){await lock.query('ROLLBACK');throw error;}finally{lock.release();}
  const expired=await queued;eq(expired.awardPoints,100,'A request queued before expiry uses acceptance time after the lock');eq(expired.bonus,null);eq((await profile(a)).bonus,null);
  eq(await rpc('answer',firstInput),first,'An expired receipt still does not restart the timer');eq((await profile(a)).bonus,null);
  phase='second jackpot';await forceAward(100000);const second=await rpc('answer',answer(a,quiz,4));eq(second.awardPoints,100000);ok(second.bonus.id!==first.bonus.id,'A later jackpot gets a distinct event');ok(Date.parse(second.bonus.startedAt)>=Date.parse(first.bonus.endsAt));eq(await rpc('answer',firstInput),first);eq((await profile(a)).bonus,second.bonus,'Old receipt cannot overwrite a newer window');
  const beforeWallet=await shop('wallet',a),newDraw=uuid(),[paid,drew]=await Promise.all([rpc('answer',answer(a,quiz,5)),shop('draw',{...a,requestId:newDraw,expectedPrice:100000,expectedCatalogVersion:2})]);eq(paid.awardPoints,500);ok(!drew.error,'Purchasing still works while earning bonus income');eq(drew.cost,100000,'The concurrent new draw uses the acknowledged100k price');const afterWallet=await shop('wallet',a);eq(afterWallet.totalIncome,beforeWallet.totalIncome+500);eq(afterWallet.spent,beforeWallet.spent+100000);eq(afterWallet.balance,afterWallet.totalIncome-afterWallet.spent);eq((await profile(a)).bonus,second.bonus);
  phase='constraints and ACL';
  await assert.rejects(db.query('UPDATE target_private.profiles SET bonus_ends_at=bonus_ends_at+interval \'1 second\' WHERE member_id=$1',[a.memberId]),e=>e.code==='23514');checks++;
  await assert.rejects(db.query('UPDATE target_private.profiles SET spent_points=total_points+10000 WHERE member_id=$1',[a.memberId]),e=>e.code==='23514');checks++;
  await assert.rejects(db.query('UPDATE target_private.profiles SET total_points=100100,correct_count=1,answered_count=1 WHERE member_id=$1',[c.memberId]),e=>e.code==='23514');checks++;
  const maxQuiz=await start(c,100);await db.query('UPDATE target_private.quizzes SET answered_count=100,correct_count=100,quiz_points=10000000 WHERE id=$1',[maxQuiz.value.quizId]);eq(Number((await db.query('SELECT quiz_points FROM target_private.quizzes WHERE id=$1',[maxQuiz.value.quizId])).rows[0].quiz_points),10000000,'100 questions can hold the new maximum');
  const acl=(await db.query("SELECT has_function_privilege('anon','target_private.bonus_snapshot(uuid)','EXECUTE') AS helper,has_table_privilege('anon','target_private.profiles','SELECT') AS table_access,(SELECT relrowsecurity FROM pg_class WHERE oid='target_private.profiles'::regclass) AS rls,has_function_privilege('anon','public.target_rpc(text,text,jsonb)','EXECUTE') AS rpc")).rows[0];eq(acl,{helper:false,table_access:false,rls:true,rpc:true});
  const anon=await db.connect();try{await anon.query('SET ROLE anon');eq((await anon.query("SELECT public.target_rpc('bad','profile','{}') AS value")).rows[0].value.error.code,'RPC_FORBIDDEN');await assert.rejects(anon.query('SELECT target_private.bonus_snapshot($1)',[a.memberId]),e=>e.code==='42501');checks++;}finally{await anon.query('RESET ROLE');anon.release();}
  await db.query(normalOdds);passed=true;console.log(JSON.stringify({bonusDatabase:'passed',checks,actualDurationVerified:true,concurrencyVerified:true,legacyReceiptsPreserved:true,walletPreserved:true,cloudVerified:false}));
 }catch(error){console.error('Bonus DB verification failed at '+phase+': '+(error.code||error.name));process.exitCode=1;}
 finally{await db.end();await fs.mkdir(path.join(root,'test-results'),{recursive:true});await fs.writeFile(path.join(root,'test-results/bonus-db-results.json'),JSON.stringify({bonusDatabase:passed?'passed':'failed',phase,checks,cloudVerified:false})+'\n');}
})();
