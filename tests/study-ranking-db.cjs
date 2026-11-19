'use strict';
// Actual disposable loopback Postgres only. Never hosted or learner accounts.
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const fs=require('node:fs/promises'),path=require('node:path');
const {Client}=require('pg');
const {generateQuestions}=require('../server/questions.cjs');
const root=path.resolve(__dirname,'..'),migration='20261119033108_target_study_only_ranking.sql';
const database='target_study_rank_'+process.pid+'_'+crypto.randomBytes(4).toString('hex')+'_test';
const secret=crypto.randomBytes(40).toString('hex'),uid=()=>crypto.randomUUID();
const actor={memberId:'00000000-0000-4000-8000-000000000001',name:'Study Leader'};
let admin,db,created=false,checks=0;
const eq=(actual,expected,message)=>{checks++;assert.deepEqual(actual,expected,message);};
const ok=(value,message)=>{checks++;assert(value,message);};
const rpc=async(action,input={},key=secret)=>(await db.query('SELECT public.target_rpc($1,$2,$3::jsonb) value',[key,action,JSON.stringify(input)])).rows[0].value;
const ranking=async()=>(await rpc('ranking')).ranking;
async function rowHashes(){
 const tables=(await db.query("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='target_private' AND c.relkind='r' ORDER BY c.relname")).rows;
 const result={};for(const {relname}of tables){assert(/^[a-z_]+$/.test(relname));result[relname]=(await db.query('SELECT md5(coalesce(string_agg(to_jsonb(t)::text,\'\' ORDER BY to_jsonb(t)::text),\'\')) hash FROM target_private.'+relname+' t')).rows[0].hash;}return result;
}
async function functions(){return(await db.query("SELECT oid::regprocedure::text signature,prosrc,prosecdef,proconfig,proacl::text,provolatile,proisstrict FROM pg_proc WHERE pronamespace IN('target_private'::regnamespace,'public'::regnamespace) ORDER BY oid::regprocedure::text")).rows;}
async function schema(){return(await db.query("SELECT c.relname,c.relrowsecurity,c.relacl::text,(SELECT jsonb_agg(pg_get_indexdef(i.indexrelid) ORDER BY i.indexrelid::regclass::text) FROM pg_index i WHERE i.indrelid=c.oid) indexes,(SELECT jsonb_agg(pg_get_triggerdef(t.oid) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal) triggers FROM pg_class c WHERE c.relnamespace='target_private'::regnamespace AND c.relkind='r' ORDER BY c.relname")).rows;}
const score=async name=>(await ranking()).find(row=>row.name===name)?.totalPoints;
async function main(){
 eq(process.env.NODE_ENV,'test');const url=new URL(process.env.DATABASE_URL||'');ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&!url.search&&!url.hash,'loopback test DB only');
 const owner=new URL(url);owner.pathname='/postgres';admin=new Client({connectionString:owner.href});await admin.connect();await admin.query('CREATE DATABASE "'+database+'"');created=true;url.pathname='/'+database;db=new Client({connectionString:url.href});await db.connect();
 await db.query("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN;END IF;IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN;END IF;IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN;END IF;END $$");
 for(const file of(await fs.readdir(path.join(root,'supabase/migrations'))).filter(x=>/^\d+_.*\.sql$/.test(x)&&x!==migration).sort())await db.query(await fs.readFile(path.join(root,'supabase/migrations',file),'utf8'));
 await db.query("INSERT INTO target_private.server_credentials(singleton,key_hash) VALUES(true,encode(sha256(convert_to($1,'UTF8')),'hex'))",[secret]);
 eq(await ranking(),[],'no fabricated ranking entries');
 const fixtures=[
  [actor.memberId,actor.name,30,40,10000,0,0,0,0,'2026-01-03'],
  ['00000000-0000-4000-8000-000000000002','External Rich',3,3,10101000,1000000,1000000,8000000,100000,'2026-01-01'],
  ['00000000-0000-4000-8000-000000000003','No Study Yet',0,0,5000000,0,0,5000000,0,'2026-01-01'],
  ['00000000-0000-4000-8000-000000000004','Study Tie A',10,12,3000,0,0,0,0,'2026-01-03'],
  ['00000000-0000-4000-8000-000000000005','Study Tie B',10,12,3000,0,0,0,0,'2026-01-01'],
  ['00000000-0000-4000-8000-000000000006','Restored Study',20,24,5000,0,0,0,0,'2026-01-01'],
  ['00000000-0000-4000-8000-000000000007','Negative Nonstudy',20,24,2000,0,0,-4000,0,'2026-01-01']
 ];
 for(const f of fixtures)await db.query('INSERT INTO target_private.profiles(member_id,name,correct_count,answered_count,total_points,calculus_points,birthday_points,casino_net,calculus_forgiven_points,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',f);
 const oldRanking=await ranking();eq(oldRanking[0].name,'External Rich','baseline ranks shared total income');
 const beforeRows=await rowHashes(),beforeFunctions=await functions(),beforeSchema=await schema();
 const oldRpc=beforeFunctions.find(f=>f.signature==='target_rpc(text,text,jsonb)'||f.signature==='public.target_rpc(text,text,jsonb)');ok(oldRpc,'old RPC exists');
 const snapshots=(await db.query('SELECT member_id,target_private.wallet_finance_state(p) value FROM target_private.profiles p ORDER BY member_id')).rows;
 await db.query(await fs.readFile(path.join(root,'supabase/tests/study_ranking_preflight.sql'),'utf8'));
 await db.query(await fs.readFile(path.join(root,'supabase/migrations',migration),'utf8'));
 eq(await rowHashes(),beforeRows,'migration changes no wallet, account, item, history, award, achievement or quota row');
 eq(await schema(),beforeSchema,'all table RLS, grants, indexes and triggers remain identical');
 eq((await db.query('SELECT member_id,target_private.wallet_finance_state(p) value FROM target_private.profiles p ORDER BY member_id')).rows,snapshots,'all wallet snapshots remain identical');
 const afterFunctions=await functions();
 for(const f of beforeFunctions){const current=afterFunctions.find(row=>row.signature===f.signature);if(f===oldRpc){eq({...current,prosrc:f.prosrc},f,'RPC security/config/grants unchanged');}else eq(current,f,'unrelated function unchanged: '+f.signature);}
 const sql=await fs.readFile(path.join(root,'supabase/migrations',migration),'utf8'),oldBranch=sql.match(/old_branch text:=\$old\$([\s\S]*?)\$old\$/)[1],newBranch=sql.match(/new_branch text:=\$new\$([\s\S]*?)\$new\$/)[1];
 eq(afterFunctions.find(row=>row.signature===oldRpc.signature).prosrc,oldRpc.prosrc.replace(oldBranch,newBranch),'ONLY the read-only ranking branch changes');
 const rows=await ranking();eq(rows.map(row=>row.name),['Study Leader','Negative Nonstudy','Restored Study','Study Tie A','Study Tie B','External Rich']);
 eq(rows.map(row=>row.totalPoints),[10000,6000,5000,3000,3000,1000],'score excludes every nonstudy component and preserves current study baseline');
 eq(rows.map(row=>row.rank),[1,2,3,4,5,6]);eq(Object.keys(rows[0]).sort(),['correctCount','name','rank','totalPoints']);
 ok(!rows.some(row=>row.name==='No Study Yet'),'external-only account remains ineligible');
 const readOnly=await rowHashes();await ranking();eq(await rowHashes(),readOnly,'ranking reads never modify quota or data');
 eq((await rpc('ranking',{},'wrong-secret')).error.code,'RPC_FORBIDDEN');eq((await rpc('ranking',{memberId:actor.memberId})).error.code,'INVALID_REQUEST');
 for(const [label,changes]of[
  ['calculus','total_points=total_points+10000,calculus_points=calculus_points+10000'],
  ['birthday','total_points=total_points+1000000,birthday_points=birthday_points+1000000'],
  ['PvP and PvE game rewards','total_points=total_points+100000,casino_net=casino_net+100000'],
  ['manual income reduction','total_points=total_points-500,casino_net=casino_net-500'],
  ['spending','spent_points=spent_points+100']
 ]){
  const before=await ranking();await db.query('UPDATE target_private.profiles SET '+changes+',updated_at=clock_timestamp() WHERE member_id=$1',['00000000-0000-4000-8000-000000000004']);eq(await ranking(),before,label+' never changes study scores or tie order');
 }
 const beforeWeight=await ranking();const credit=(await db.query('SELECT public.target_weight_rpc($1,\'credit\',$2::jsonb) value',[secret,{memberId:'00000000-0000-4000-8000-000000000004',name:'Study Tie A',sessionId:'historic_workout_1234',reps:130}])).rows[0].value;ok(!credit.error,JSON.stringify(credit));eq(await ranking(),beforeWeight,'real Weight 130000 credit leaves study ranking unchanged');
 const requestId=uid(),questions=generateQuestions({book:'target1900',from:1,to:2,count:100,direction:'japanese',requestId});
 const quiz=await rpc('start',{...actor,book:'target1900',from:1,to:2,direction:'japanese',requestId,questions});ok(!quiz.error,JSON.stringify(quiz));
 const beforeNormal=await score(actor.name),normal=await rpc('answer',{...actor,quizId:quiz.quizId,questionId:questions[0].id,choiceId:questions[0].correctChoiceId,requestId:uid()});ok(!normal.error,JSON.stringify(normal));ok(normal.awardPoints>0);eq(await score(actor.name),beforeNormal+normal.awardPoints,'normal answer includes its full actual server award/bonus');
 const wrong=await rpc('answer',{...actor,quizId:quiz.quizId,questionId:questions[1].id,choiceId:questions[1].choices.find(c=>c.id!==questions[1].correctChoiceId).id,requestId:uid()});ok(!wrong.error);eq(wrong.awardPoints,0);
 const reviewId=uid(),reviewQuestions=generateQuestions({book:'target1900',from:questions[1].number,to:questions[1].number,count:100,direction:'japanese',requestId:reviewId});
 const review=await rpc('review_start',{...actor,book:'target1900',from:1,to:2,direction:'japanese',count:10,requestId:reviewId,questions:reviewQuestions});ok(!review.error,JSON.stringify(review));
 const beforeReview=await score(actor.name),answerInput={...actor,quizId:review.quizId,questionId:reviewQuestions[0].id,choiceId:reviewQuestions[0].correctChoiceId,requestId:uid()};const answer=await rpc('answer',answerInput);ok(!answer.error,JSON.stringify(answer));ok(answer.awardPoints>0);eq(await score(actor.name),beforeReview+answer.awardPoints,'review answer earns the same study-only score');
 const accepted=await rowHashes();eq(await rpc('answer',answerInput),answer);eq(await rowHashes(),accepted,'answer replay still changes no data');
 await db.query('UPDATE target_private.profiles SET total_points=total_points-200 WHERE member_id=$1',['00000000-0000-4000-8000-000000000006']);eq(await score('Restored Study'),4800,'authorized study reductions remain reflected instead of resurrecting old answer sums');
 await db.query(await fs.readFile(path.join(root,'supabase/tests/study_ranking_verify.sql'),'utf8'));checks++;
 const result={passed:true,checks,migration,beforeRpcBodyMD5:crypto.createHash('md5').update(oldRpc.prosrc).digest('hex'),afterRpcBodyMD5:crypto.createHash('md5').update(afterFunctions.find(row=>row.signature===oldRpc.signature).prosrc).digest('hex'),hostedRequests:0,acceptedHostedMutations:0};
 console.log(JSON.stringify(result));
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1;}).finally(async()=>{if(db)await db.end();if(admin){if(created)await admin.query('DROP DATABASE "'+database+'"');await admin.end();}});
