'use strict';
// Synthetic records only, inside a dedicated loopback PostgreSQL test database.
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs/promises'),path=require('node:path');
const {Client,Pool}=require('pg');
const {generateQuestions}=require('../server/questions.cjs');
const root=path.resolve(__dirname,'..'),url=new URL(process.env.DATABASE_URL||'');
assert.equal(process.env.NODE_ENV,'test');assert(['localhost','127.0.0.1','[::1]'].includes(url.hostname));url.pathname='/target_mastery_test';
const db=new Pool({connectionString:url.href,max:8}),uuid=()=>crypto.randomUUID(),secret=crypto.randomBytes(32).toString('base64url');
const migration='20261106095434_target_word_mastery.sql',person=name=>({memberId:uuid(),name}),a=person('定着確認A'),b=person('定着確認B');
let checks=0,phase='setup',passed=false;
const eq=(x,y,label)=>{checks++;assert.deepEqual(x,y,label);},ok=(x,label)=>{checks++;assert(x,label);};
const rpc=(action,input,key=secret)=>db.query('SELECT public.target_rpc($1,$2,$3::jsonb) AS result',[key,action,JSON.stringify(input)]).then(r=>r.rows[0].result);
const definition=name=>db.query('SELECT pg_get_functiondef($1::regprocedure) AS source',[name]).then(r=>r.rows[0].source);
async function start(m,number,book='target1900',direction='english'){
 const settings={book,direction,count:10,from:number,to:number,requestId:uuid()},questions=generateQuestions(settings),value=await rpc('start',{...m,requestId:settings.requestId,book,direction,from:number,to:number,questions});
 ok(!value.error,'Canonical single-word quiz starts');return{value,questions};
}
const input=(m,q,correct=true,requestId=uuid())=>({...m,quizId:q.value.quizId,questionId:q.questions[0].id,choiceId:correct?q.questions[0].correctChoiceId:q.questions[0].choices.find(x=>x.id!==q.questions[0].correctChoiceId).id,requestId});
async function attempt(m,n,correct=true,book='target1900',direction='english',ageDays=0){const q=await start(m,n,book,direction),i=input(m,q,correct),result=await rpc('answer',i);ok(!result.error,'Server confirms the answer');if(ageDays)await db.query("UPDATE target_private.answers SET created_at=clock_timestamp()-$2*interval'1 day' WHERE quiz_id=$1",[q.value.quizId,ageDays]);return{q,i,result};}
const word=(m,n,book='target1900')=>db.query('SELECT correct_streak,needs_review FROM target_private.word_mastery WHERE member_id=$1 AND book=$2 AND word_number=$3',[m.memberId,book,n]).then(r=>r.rows[0]);
const mastery=(m,book='target1900')=>rpc('mastery',{...m,book});
const review=(m,from=1,to=100)=>({...m,book:'target1900',direction:'english',count:10,from,to,requestId:uuid()});
(async()=>{
 try{
  const adminURL=new URL(url.href);adminURL.pathname='/postgres';const admin=new Client({connectionString:adminURL.href});await admin.connect();try{await admin.query('DROP DATABASE IF EXISTS target_mastery_test WITH(FORCE)');await admin.query('CREATE DATABASE target_mastery_test');}finally{await admin.end();}
  const files=(await fs.readdir(path.join(root,'supabase/migrations'))).filter(n=>/^\d+_.*\.sql$/.test(n)).sort();
  for(const file of files.filter(n=>n<migration))await db.query(await fs.readFile(path.join(root,'supabase/migrations',file),'utf8'));
  await db.query("INSERT INTO target_private.server_credentials(singleton,key_hash) VALUES(true,encode(sha256(convert_to($1,'UTF8')),'hex'))",[secret]);
  const oldScorer=await definition('public.target_rpc(text,text,jsonb)'),normalReward=await definition('target_private.reward_points_for_roll(integer)');
  await db.query("CREATE OR REPLACE FUNCTION target_private.reward_points_for_roll(p_roll integer) RETURNS integer LANGUAGE sql IMMUTABLE STRICT SECURITY INVOKER SET search_path=pg_catalog AS 'SELECT CASE WHEN p_roll BETWEEN 0 AND 99 THEN 100 ELSE NULL END'");
  phase='historical source';
  await attempt(a,1);await attempt(a,1);await attempt(a,2,false);const firstCorrect=await attempt(a,3);await attempt(a,4,true,'target1900','english',8);await attempt(a,4,true,'target1900','english',8);await attempt(a,5,false,'target1900','english',8);await attempt(a,5);
  const invertedFirst=await attempt(a,6);const invertedMiss=await attempt(a,6,false);await attempt(a,6);
  await db.query("UPDATE target_private.answers SET created_at=clock_timestamp()+interval'1 hour' WHERE quiz_id=$1",[invertedFirst.q.value.quizId]);
  await db.query("UPDATE target_private.answers SET created_at=clock_timestamp()-interval'1 hour' WHERE quiz_id=$1",[invertedMiss.q.value.quizId]);
  const unknownMiss=await attempt(a,7,false);await attempt(a,7);await attempt(a,7);
  await db.query("UPDATE target_private.answers SET response=response-'totalPoints' WHERE quiz_id=$1",[unknownMiss.q.value.quizId]);
  const knownZeroMiss=await attempt(a,8,false);await attempt(a,8);await attempt(a,8);
  await db.query("UPDATE target_private.answers SET response=jsonb_set(response,'{totalPoints}','0') WHERE quiz_id=$1",[knownZeroMiss.q.value.quizId]);
  const profilesBefore=(await db.query('SELECT * FROM target_private.profiles ORDER BY member_id')).rows,answersBefore=(await db.query('SELECT * FROM target_private.answers ORDER BY quiz_id,question_id')).rows;
  const logicalBefore=Number((await db.query('SELECT logical_bytes FROM target_private.system_state')).rows[0].logical_bytes);
  phase='queued old body during migration';
  const queuedQuiz=await start(a,9),queuedInput=input(a,queuedQuiz),migrateClient=await db.connect(),oldClient=await db.connect();let pending;
  try{
   await migrateClient.query('BEGIN');await migrateClient.query('SELECT pg_advisory_xact_lock(991101)');
   const oldPid=(await oldClient.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
   pending=oldClient.query('SELECT public.target_rpc($1,$2,$3::jsonb) AS result',[secret,'answer',JSON.stringify(queuedInput)]);
   let waiting=false;for(let i=0;i<50;i++){const activity=(await db.query('SELECT wait_event_type,wait_event FROM pg_stat_activity WHERE pid=$1',[oldPid])).rows[0];if(activity?.wait_event_type==='Lock'&&activity.wait_event==='advisory'){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}
   ok(waiting,'An actual old scorer invocation is queued on991101 before replacement');
   await migrateClient.query(await fs.readFile(path.join(root,'supabase/migrations',migration),'utf8'));await migrateClient.query('COMMIT');
   const result=(await pending).rows[0].result;ok(!result.error,'Already-running old scorer succeeds after migration');eq(await word(a,9),{correct_streak:1,needs_review:false},'Permanent trigger records an old compiled scorer invocation');
  }catch(error){await migrateClient.query('ROLLBACK');throw error;}finally{migrateClient.release();oldClient.release();}
  for(const file of files.filter(n=>n>migration))await db.query(await fs.readFile(path.join(root,'supabase/migrations',file),'utf8'));
  eq(await word(a,1),{correct_streak:2,needs_review:false},'Retained recent two correct answers backfill mastery');eq(await word(a,2),{correct_streak:0,needs_review:true});eq(await word(a,3),{correct_streak:1,needs_review:false});eq(await word(a,4),{correct_streak:0,needs_review:false},'Uncertain old history cannot fabricate consecutive mastery');eq(await word(a,5),{correct_streak:1,needs_review:true},'Known old miss remains until two safe subsequent correct answers');
  eq(await word(a,6),{correct_streak:1,needs_review:true},'Gross points prove order despite inverted transaction timestamps');eq(await word(a,7),{correct_streak:0,needs_review:true},'Missing legacy wrong gross snapshot cannot prove order');eq(await word(a,8),{correct_streak:2,needs_review:false},'An explicit numeric zero miss snapshot has a known order');
  const persistedAnswers=(await db.query('SELECT * FROM target_private.answers WHERE quiz_id<>$1 ORDER BY quiz_id,question_id',[queuedQuiz.value.quizId])).rows;eq(persistedAnswers,answersBefore,'Historical receipts remain unchanged');
  const afterProfile=(await db.query('SELECT * FROM target_private.profiles ORDER BY member_id')).rows;eq(afterProfile[0].spent_points,profilesBefore[0].spent_points);eq(Number(afterProfile[0].total_points),Number(profilesBefore[0].total_points)+100,'Only queued accepted answer changes historical income');
  const logicalAfter=Number((await db.query('SELECT logical_bytes FROM target_private.system_state')).rows[0].logical_bytes),queuedCharge=Number((await db.query('SELECT charged_bytes FROM target_private.quizzes WHERE id=$1',[queuedQuiz.value.quizId])).rows[0].charged_bytes)+Number((await db.query('SELECT charged_bytes FROM target_private.answers WHERE quiz_id=$1',[queuedQuiz.value.quizId])).rows[0].charged_bytes);
  eq(logicalAfter,logicalBefore+queuedCharge+9*256,'All persistent per-word rows are separately charged exactly once');
  eq(await rpc('answer',firstCorrect.i),firstCorrect.result);eq(await rpc('answer',{...firstCorrect.i,requestId:uuid()}),firstCorrect.result);eq(await word(a,3),{correct_streak:1,needs_review:false},'Same and alternate receipt IDs cannot count as a second correct');
  phase='per-word streak';
  let m=await mastery(a);eq(m.sections.length,19);eq(m.sections[0],{section:1,from:1,to:100,total:100,mastered:2,percent:2,reviewCount:4});eq(m.reviewNumbers,[2,5,6,7]);
  await attempt(a,10);eq(await word(a,10),{correct_streak:1,needs_review:false});await attempt(a,10,true,'target1900','japanese');eq(await word(a,10),{correct_streak:2,needs_review:false},'Directions share the same word state');
  await attempt(a,10,false);eq(await word(a,10),{correct_streak:0,needs_review:true});await attempt(a,10);eq(await word(a,10),{correct_streak:1,needs_review:true});await attempt(a,10);eq(await word(a,10),{correct_streak:2,needs_review:false});await attempt(a,10,false);eq(await word(a,10),{correct_streak:0,needs_review:true},'Mastery can be lost again');
  const twice=await start(a,20),sameInput=input(a,twice),sameResults=await Promise.all([rpc('answer',sameInput),rpc('answer',sameInput)]);eq(sameResults[0],sameResults[1]);eq(await word(a,20),{correct_streak:1,needs_review:false},'Concurrent duplicate requests count once');
  const one=await start(a,21),two=await start(a,21);await Promise.all([rpc('answer',input(a,one)),rpc('answer',input(a,two))]);eq(await word(a,21),{correct_streak:2,needs_review:false},'Concurrent independent correct answers update atomically');
  await attempt(a,10,true,'target1000');eq(await word(a,10,'target1000'),{correct_streak:1,needs_review:false});eq(await word(a,10),{correct_streak:0,needs_review:true});eq((await mastery(a,'target1000')).sections.length,10);eq((await mastery(a,'target1000')).sections[0].percent,0);
  await attempt(b,10);eq(await word(b,10),{correct_streak:1,needs_review:false});eq((await mastery(b)).reviewNumbers,[],'Different member does not inherit another review pool');
  await attempt(a,101);await attempt(a,101);m=await mastery(a);eq(m.sections[1].percent,1);eq(m.sections[0].percent,3,'Denominator includes all100 terms, not just attempted ones');
  phase='review selection and replay';
  const reviewInput=review(a),candidate=await rpc('review_start',reviewInput);eq(candidate.reviewNumbers,[2,5,6,7,10]);
  const selected=generateQuestions({book:reviewInput.book,direction:reviewInput.direction,count:reviewInput.count,from:reviewInput.from,to:reviewInput.to,requestId:reviewInput.requestId},candidate.reviewNumbers);
  const accepted=await rpc('review_start',{...reviewInput,questions:selected});ok(!accepted.error);eq(accepted.total,5,'Review clamps to eligible terms instead of repeating/unattempted terms');eq((await db.query('SELECT questions FROM target_private.quizzes WHERE id=$1',[accepted.quizId])).rows[0].questions.map(q=>q.number).sort((x,y)=>x-y),[2,5,6,7,10]);
  for(const n of [2,5,6,7,10]){await attempt(a,n);await attempt(a,n);}
  eq((await mastery(a)).reviewNumbers,[]);eq((await rpc('review_start',reviewInput)).quizId,accepted.quizId,'Replay succeeds even when all original terms are now mastered');eq((await rpc('review_start',{...reviewInput,questions:selected})).quizId,accepted.quizId);
  const normalCollision=await rpc('start',{...a,requestId:reviewInput.requestId,book:'target1900',direction:'english',from:1,to:100,questions:selected});eq(normalCollision.error.code,'IDEMPOTENCY_CONFLICT','Normal and review requests cannot reuse each other');
  eq((await rpc('review_start',review(a))).error.code,'REVIEW_EMPTY');
  await attempt(a,31,false);const staleInput=review(a),stalePool=await rpc('review_start',staleInput),staleQuestions=generateQuestions({book:'target1900',direction:'english',count:10,from:1,to:100,requestId:staleInput.requestId},stalePool.reviewNumbers);await attempt(a,31);await attempt(a,31);
  eq((await rpc('review_start',{...staleInput,questions:staleQuestions})).error.code,'REVIEW_CHANGED','Eligibility is rechecked after choices generation');eq((await db.query('SELECT count(*)::int AS n FROM target_private.quizzes WHERE member_id=$1 AND request_id=$2',[a.memberId,staleInput.requestId])).rows[0].n,0);
  await attempt(a,33,false);await attempt(a,150,false);eq((await rpc('review_start',review(a))).reviewNumbers,[33],'Range excludes another section');
  const invalidReview=review(a),unattemptedQuestion=generateQuestions({book:'target1900',direction:'english',count:10,from:32,to:32,requestId:uuid()});eq((await rpc('review_start',{...invalidReview,questions:unattemptedQuestion})).error.code,'REVIEW_CHANGED','Cannot put an unattempted word in a review quiz');
  phase='auth and quota';
  const countBefore=(await db.query('SELECT count(*)::int AS n FROM target_private.word_mastery')).rows[0].n;eq((await rpc('mastery',{...a,book:'target1900'},'invalid-credential')).error.code,'RPC_FORBIDDEN');eq((await db.query('SELECT count(*)::int AS n FROM target_private.word_mastery')).rows[0].n,countBefore);
  eq((await rpc('mastery',{...a,book:'target1900',member:'forged'})).error.code,'INVALID_REQUEST');
  const foreign=await start(a,34);eq((await rpc('answer',input(b,foreign))).error.code,'QUIZ_NOT_FOUND');eq(await word(b,34),undefined);
  const usage=Number((await db.query('SELECT logical_bytes FROM target_private.system_state')).rows[0].logical_bytes),beforeQuota=await rpc('profile',a);await db.query('UPDATE target_private.system_state SET logical_bytes=104857600 WHERE singleton');eq((await rpc('answer',input(a,foreign))).error.code,'CAPACITY_LIMIT');eq(await word(a,34),undefined);eq(await rpc('profile',a),beforeQuota,'Failed capacity leaves all rewards and counts unchanged');await db.query('UPDATE target_private.system_state SET logical_bytes=$1 WHERE singleton',[usage]);
  const newScorer=await definition('public.target_rpc(text,text,jsonb)'),pendingAnswer=input(a,foreign),canonical=foreign.questions[0];
  const prospective={correct:true,correctChoiceId:canonical.correctChoiceId,correctText:canonical.correctText,answeredCount:1,correctCount:1,total:1,awardPoints:100,quizPoints:100,totalPoints:beforeQuota.totalPoints+100,bonus:null,finished:true,nextQuestion:null};
  const nextBytes=(await db.query('SELECT pg_column_size($1::jsonb)+256 AS n',[JSON.stringify(prospective)])).rows[0].n;
  try{
   await db.query(oldScorer);await db.query('UPDATE target_private.system_state SET logical_bytes=$1 WHERE singleton',[104857600-nextBytes-128]);
   await assert.rejects(rpc('answer',pendingAnswer),e=>e.code==='P0750');checks++;
   eq(await word(a,34),undefined,'Old scorer cannot bypass permanent mastery quota');eq(await rpc('profile',a),beforeQuota,'Trigger failure rolls back the entire old scorer answer');
   eq((await db.query('SELECT answered_count FROM target_private.quizzes WHERE id=$1',[foreign.value.quizId])).rows[0].answered_count,0);
  }finally{await db.query(newScorer);await db.query('UPDATE target_private.system_state SET logical_bytes=$1 WHERE singleton',[usage]);}
  const oldReceipts=(await db.query('SELECT count(*)::int AS n FROM target_private.answers')).rows[0].n;await db.query("UPDATE target_private.quizzes SET expires_at=clock_timestamp()-interval'9 days' WHERE member_id=$1",[a.memberId]);await start(b,35);eq(await word(a,1),{correct_streak:2,needs_review:false},'Permanent mastery survives normal expired quiz cleanup');ok((await db.query('SELECT count(*)::int AS n FROM target_private.answers')).rows[0].n<oldReceipts,'Actual expired answer cleanup ran');eq((await mastery(a)).reviewNumbers,[33,150]);
  const acl=(await db.query("SELECT has_table_privilege('anon','target_private.word_mastery','SELECT') AS read,has_table_privilege('authenticated','target_private.word_mastery','UPDATE') AS write,has_function_privilege('anon','target_private.mastery_snapshot(uuid,text)','EXECUTE') AS snapshot,has_function_privilege('anon','target_private.record_word_mastery()','EXECUTE') AS trigger,(SELECT relrowsecurity FROM pg_class WHERE oid='target_private.word_mastery'::regclass) AS rls")).rows[0];eq(acl,{read:false,write:false,snapshot:false,trigger:false,rls:true});
  await assert.rejects(db.query('INSERT INTO target_private.word_mastery(member_id,book,word_number,correct_streak,needs_review) VALUES($1,$2,1901,1,false)',[a.memberId,'target1900']),e=>e.code==='23514');checks++;
  await assert.rejects(db.query('UPDATE target_private.word_mastery SET needs_review=true WHERE member_id=$1 AND correct_streak=2',[a.memberId]),e=>e.code==='23514');checks++;
  await db.query(normalReward);passed=true;console.log(JSON.stringify({masteryDatabase:'passed',checks,retainedBackfillVerified:true,queuedOldScorerVerified:true,realPostgres:true,cloudVerified:false}));
 }catch(error){console.error('Mastery DB verification failed at '+phase+': '+(error.code||error.name)+' '+error.message);process.exitCode=1;}
 finally{await db.end();await fs.mkdir(path.join(root,'test-results'),{recursive:true});await fs.writeFile(path.join(root,'test-results/mastery-db-results.json'),JSON.stringify({masteryDatabase:passed?'passed':'failed',phase,checks,cloudVerified:false})+'\n');}
})();
