'use strict';
// Fresh loopback PostgreSQL with synthetic identities only; never hosted data.
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs/promises');
const path=require('node:path');
const {Client}=require('pg');
const {questionBlock}=require('../server/challenge.cjs');
const root=path.resolve(__dirname,'..'),migrationName='20261115142451_target_challenge_graded_choice_feedback.sql';
const reviewMigration='20261115144738_target_challenge_defeat_mistake_review.sql';
const resetMigration='20261115150438_target_challenge_progress_reset_and_late_level_pace.sql';
const uid=()=>crypto.randomUUID(),secret=crypto.randomBytes(40).toString('hex');
const name='target_feedback_'+process.pid+'_'+crypto.randomBytes(4).toString('hex')+'_test';
const actor=label=>({memberId:uid(),name:label,sessionHash:crypto.randomBytes(32).toString('hex')});
const member=actor('Choice Feedback'),stranger=actor('Other Feedback');
let admin,db,other,created=false,checks=0;
const eq=(a,b,label)=>{checks++;assert.deepEqual(a,b,label);};
const ok=(value,label)=>{checks++;assert(value,label);};
async function rpc(action,params={},who=member,client=db){
 const input={...who,...params};
 if(['start','answer','pause','resume','abort'].includes(action)&&!input.requestId)input.requestId=uid();
 return(await client.query('SELECT public.target_challenge_rpc($1,$2,$3::jsonb) x',[secret,action,JSON.stringify(input)])).rows[0].x;
}
async function row(id){return(await db.query('SELECT to_jsonb(r) x FROM target_private.challenge_runs r WHERE id=$1',[id])).rows[0].x;}
function hidden(value){
 ok(!JSON.stringify(value).includes('correctChoiceId'),'ungraded/current public state has no correctness key');
 ok(!JSON.stringify(value).includes('correctText'),'public response has no private correct text');
}
function correction(result,question){
 ok(result.ok);eq(result.answer.correctChoiceId,question.correctChoiceId,'correction names the just-graded choice only');
 ok(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(result.answer.correctChoiceId));
 ok(question.choices.some(c=>c.id===result.answer.correctChoiceId),'correction belongs to the answered four choices');
 const {answer,...publicState}=result;hidden(publicState);ok(!Object.hasOwn(answer,'correctText'));
 if(result.run.question)ok(!result.run.question.choices.some(c=>c.id===result.answer.correctChoiceId),'the graded ID is not a correctness key for the next question');
}
async function snapshot(){
 const tables=(await db.query("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='target_private' AND c.relkind='r' ORDER BY c.relname")).rows;
 const hashes={};for(const {relname} of tables){assert(/^[a-z0-9_]+$/.test(relname));hashes[relname]=(await db.query("SELECT md5(coalesce(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text),'')) h FROM target_private."+relname+' t')).rows[0].h;}return hashes;
}
async function fenced(id){await db.query("UPDATE target_private.challenge_runs SET next_attack_at=clock_timestamp()+interval '3 seconds' WHERE id=$1",[id]);}
async function main(){
 eq(process.env.NODE_ENV,'test');const url=new URL(process.env.DATABASE_URL||'');
 ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&!url.search&&!url.hash,'disposable localhost database only');
 const owner=new URL(url);owner.pathname='/postgres';admin=new Client({connectionString:owner.href});await admin.connect();
 await admin.query('CREATE DATABASE "'+name+'"');created=true;url.pathname='/'+name;
 db=new Client({connectionString:url.href});other=new Client({connectionString:url.href});await db.connect();await other.connect();
 await db.query("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF; END $$");
 const dir=path.join(root,'supabase/migrations');for(const file of(await fs.readdir(dir)).filter(f=>/^\d+_.*\.sql$/.test(f)&&![migrationName,reviewMigration,resetMigration].includes(f)).sort())await db.query(await fs.readFile(path.join(dir,file),'utf8'));
 await db.query("INSERT INTO target_private.server_credentials(singleton,key_hash) VALUES(true,encode(sha256(convert_to($1,'UTF8')),'hex'))",[secret]);
 for(const who of[member,stranger])await db.query('INSERT INTO target_private.profiles(member_id,name) VALUES($1,$2)',[who.memberId,who.name]);
 let started=await rpc('start',{level:1});hidden(started);const id=started.run.id;
 let supplied=await rpc('next',{runId:id,questions:questionBlock(1)});hidden(supplied);
 let q=(await row(id)).questions[0];const oldInput={requestId:uid(),runId:id,questionId:q.id,choiceId:q.correctChoiceId};
 let result=await rpc('answer',oldInput);ok(result.ok);ok(!Object.hasOwn(result.answer,'correctChoiceId'),'historical accepted answer has the old metadata schema');
 await rpc('pause',{runId:id});
 const oldReceipt=(await db.query('SELECT to_jsonb(q) x FROM target_private.challenge_requests q WHERE member_id=$1 AND request_id=$2',[member.memberId,oldInput.requestId])).rows[0].x;
 const before=await snapshot(),financeBefore=(await db.query("SELECT prosrc FROM pg_proc WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure")).rows[0].prosrc;
 await db.query(await fs.readFile(path.join(dir,migrationName),'utf8'));
 eq(await snapshot(),before,'metadata-only migration changes zero existing rows, clocks, progress, wallets or receipts');
 eq((await db.query("SELECT prosrc FROM pg_proc WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure")).rows[0].prosrc,financeBefore);
 eq((await db.query("SELECT md5(prosrc) h FROM pg_proc WHERE oid='public.target_challenge_rpc(text,text,jsonb)'::regprocedure")).rows[0].h,'66e060d1532f0fa08800f30579897d9a');
 result=await rpc('answer',oldInput);eq(result.replayed,true);ok(!Object.hasOwn(result.answer,'correctChoiceId'),'old immutable answers are not backfilled with another question\'s correction');
 eq((await db.query('SELECT to_jsonb(q) x FROM target_private.challenge_requests q WHERE member_id=$1 AND request_id=$2',[member.memberId,oldInput.requestId])).rows[0].x,oldReceipt);
 hidden(await rpc('map'));hidden(await rpc('state',{runId:id}));hidden(await rpc('resume',{runId:id}));
 q=(await row(id)).questions[0];const wrong=q.choices.find(c=>c.id!==q.correctChoiceId);
 const wrongInput={requestId:uid(),runId:id,questionId:q.id,choiceId:wrong.id};await fenced(id);
 result=await rpc('answer',wrongInput);correction(result,q);eq(result.answer.correct,false);eq(result.run.playerHp,90);eq(result.run.enemyHp,100);eq(result.answer.enemyHealedHp,5);eq(result.run.streak,0);
 const wrongQuestion=q;
 hidden(await rpc('state',{runId:id}));hidden(await rpc('map'));
 q=(await row(id)).questions[0];const rightInput={requestId:uid(),runId:id,questionId:q.id,choiceId:q.correctChoiceId};await fenced(id);
 result=await rpc('answer',rightInput);correction(result,q);eq(result.answer.correct,true);eq(result.run.enemyHp,95);eq(result.run.playerHp,90);eq(result.run.streak,1);
 const rightQuestion=q,next=(await row(id)).questions[0],afterRight=await row(id);
 const replayWrong=await rpc('answer',wrongInput);eq(replayWrong.replayed,true);correction(replayWrong,wrongQuestion);eq(replayWrong.run.question.id,next.id);
 const replayRight=await rpc('answer',rightInput);eq(replayRight.replayed,true);correction(replayRight,rightQuestion);eq(replayRight.run.question.id,next.id);eq(await row(id),afterRight,'answer retries cannot consume the next question or apply damage/healing twice');
 const conflict=await rpc('answer',{...wrongInput,choiceId:wrongQuestion.correctChoiceId});eq(conflict.error.code,'CHALLENGE_REQUEST_CONFLICT');hidden(conflict);
 const invalid=await rpc('answer',{requestId:uid(),runId:id,questionId:next.id,choiceId:uid()});eq(invalid.error.code,'INVALID_CHALLENGE_REQUEST');hidden(invalid);
 const forged=await rpc('answer',{requestId:uid(),runId:id,questionId:next.id,choiceId:next.choices[0].id,correctChoiceId:next.correctChoiceId});eq(forged.error.code,'INVALID_CHALLENGE_REQUEST');hidden(forged);
 const stale=await rpc('answer',{...rightInput,requestId:uid()});eq(stale.error.code,'CHALLENGE_QUESTION_STALE');hidden(stale);
 const foreign=await rpc('state',{runId:id},stranger);eq(foreign.error.code,'CHALLENGE_NOT_FOUND');hidden(foreign);
 await fenced(id);const concurrentInput={requestId:uid(),runId:id,questionId:next.id,choiceId:next.correctChoiceId};
 const concurrent=await Promise.all([rpc('answer',concurrentInput),rpc('answer',concurrentInput,member,other)]);
 eq(concurrent.filter(x=>x.replayed===true).length,1);
 for(const response of concurrent)correction(response,next);
 eq((await row(id)).enemy_hp,90);eq((await db.query('SELECT count(*)::int n FROM target_private.challenge_requests WHERE member_id=$1 AND request_id=$2',[member.memberId,concurrentInput.requestId])).rows[0].n,1);
 // A nonwinning special reveals its graded choice while hiding the next one,
 // then the existing receipt-owned resume restores that same next question.
 await db.query('UPDATE target_private.challenge_runs SET streak=9,correct_count=9,enemy_hp=100,player_hp=90 WHERE id=$1',[id]);
 q=(await row(id)).questions[0];await fenced(id);
 const specialInput={requestId:uid(),runId:id,questionId:q.id,choiceId:q.correctChoiceId};
 result=await rpc('answer',specialInput);correction(result,q);eq(result.run.status,'paused');eq(result.run.question,null);eq(result.answer.specialPaused,true);eq(result.answer.specialPausedAt,result.run.updatedAt);eq(result.answer.specialDamage,10);eq(result.answer.healedHp,10);
 hidden(await rpc('state',{runId:id}));hidden(await rpc('map'));
 const paused=await rpc('answer',{requestId:uid(),runId:id,questionId:(await row(id)).questions[0].id,choiceId:uid()});eq(paused.error.code,'CHALLENGE_NOT_PLAYING');hidden(paused);
 hidden(await rpc('resume',{runId:id,specialRequestId:specialInput.requestId}));
 await db.query('UPDATE target_private.challenge_runs SET streak=19,correct_count=19,enemy_hp=12,player_hp=90 WHERE id=$1',[id]);q=(await row(id)).questions[0];await fenced(id);
 const winInput={requestId:uid(),runId:id,questionId:q.id,choiceId:q.correctChoiceId};
 const wins=await Promise.all([rpc('answer',winInput),rpc('answer',winInput,member,other)]);
 eq(wins.filter(x=>x.replayed===true).length,1);
 for(const won of wins){correction(won,q);eq(won.run.status,'won');eq(won.answer.specialPaused,false);eq(won.answer.specialPercent,20);eq(won.answer.specialDamage,7);eq(won.wallet.totalIncome,100000);eq(won.wallet.balance,100000);eq(won.wallet.walletRevision,1);}
 eq((await db.query('SELECT count(*)::int n FROM target_private.challenge_reward_events WHERE run_id=$1',[id])).rows[0].n,1);
 eq((await db.query('SELECT count(*)::int n FROM target_private.challenge_badges WHERE member_id=$1',[member.memberId])).rows[0].n,1);
 const earlier=await rpc('answer',specialInput);eq(earlier.replayed,true);eq(earlier.answer.correctChoiceId,specialInput.choiceId);eq(earlier.run.status,'won');ok(!Object.hasOwn(earlier,'reward'),'replaying old feedback does not attach a later winning reward');
 hidden(await rpc('state',{runId:id}));hidden(await rpc('map'));
 eq((await db.query('SELECT count(*)::int n FROM target_private.profiles p JOIN target_private.wallet_finance_projection(NULL) f USING(member_id) WHERE (p.total_points,p.spent_points,p.casino_net) IS DISTINCT FROM (f.total_points,f.spent_points,f.casino_net)')).rows[0].n,0);
 const beforeReview=await snapshot();await db.query(await fs.readFile(path.join(dir,reviewMigration),'utf8'));
 eq(await snapshot(),beforeReview,'defeat review installation preserves old correction receipts without reconstructing history');
 await db.query(await fs.readFile(path.join(dir,resetMigration),'utf8'));
 await db.query(await fs.readFile(path.join(root,'supabase/tests/challenge_levels_verify.sql'),'utf8'));checks++;
 console.log('Challenge graded-choice PostgreSQL checks passed:',checks);
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
 await Promise.allSettled([db?.end(),other?.end()]);if(created&&admin)await admin.query('DROP DATABASE "'+name+'" WITH (FORCE)');await admin?.end();
});
