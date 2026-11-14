'use strict';
// Genuine local scorer, durable rows and separate database connections only.
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs/promises'),path=require('node:path');
const {Client,Pool}=require('pg'),{generateQuestions}=require('../server/questions.cjs');
const base=new URL(process.env.DATABASE_URL||'');assert.equal(process.env.NODE_ENV,'test');assert(['localhost','127.0.0.1','[::1]'].includes(base.hostname),'Only loopback synthetic databases are allowed');
const dbName='target_reward_lock_design_test',adminURL=new URL(base),url=new URL(base);adminURL.pathname='/postgres';url.pathname='/'+dbName;
const root=path.resolve(__dirname,'..'),migration='20261109064636_target_answer_reward_lock.sql',uuid=()=>crypto.randomUUID(),secret=crypto.randomBytes(32).toString('hex');
let checks=0;const eq=(a,b,m)=>{checks++;assert.deepEqual(a,b,m);},ok=(a,m)=>{checks++;assert(a,m);};
const a={memberId:uuid(),name:'連続解答A'},b={memberId:uuid(),name:'連続解答B'};
const pool=new Pool({connectionString:url.href,max:8});
const rpc=async(action,input={})=>(await pool.query('SELECT public.target_rpc($1,$2,$3::jsonb) v',[secret,action,JSON.stringify(input)])).rows[0].v;
const gate=(locked=false,missStreak=0,recoveryStreak=0)=>({locked,missStreak,recoveryStreak});
async function begin(member,count=10){const questions=generateQuestions({book:'target1900',direction:'english',count,from:1,to:100,requestId:uuid()});const result=await rpc('start',{...member,requestId:uuid(),book:'target1900',direction:'english',from:1,to:100,questions});ok(result.quizId,'A real quiz starts');return{member,questions,result};}
function input(quiz,index,correct=true){const q=quiz.questions[index];return{...quiz.member,quizId:quiz.result.quizId,questionId:q.id,choiceId:correct?q.correctChoiceId:q.choices.find(c=>c.id!==q.correctChoiceId).id,requestId:uuid()};}
const submit=(quiz,index,correct=true)=>rpc('answer',input(quiz,index,correct));
const state=async member=>(await pool.query('SELECT reward_miss_streak,reward_correct_streak,reward_locked,total_points,correct_count,answered_count FROM target_private.profiles WHERE member_id=$1',[member.memberId])).rows[0];
(async()=>{
 const admin=new Client({connectionString:adminURL.href});await admin.connect();try{await admin.query('DROP DATABASE IF EXISTS '+dbName+' WITH (FORCE)');await admin.query('CREATE DATABASE '+dbName);}finally{await admin.end();}
 try{
  const dir=path.join(root,'supabase/migrations');for(const f of(await fs.readdir(dir)).filter(f=>f.endsWith('.sql')&&f<migration).sort())await pool.query(await fs.readFile(path.join(dir,f),'utf8'));
  await pool.query('INSERT INTO target_private.server_credentials(singleton,key_hash) VALUES(true,$1)',[crypto.createHash('sha256').update(secret).digest('hex')]);
  await pool.query("CREATE OR REPLACE FUNCTION target_private.reward_points_for_roll(p_roll integer) RETURNS integer LANGUAGE sql IMMUTABLE STRICT SECURITY INVOKER SET search_path=pg_catalog AS 'SELECT 1000'");
  const first=await begin(a,50),oldInput=input(first,0),old=await rpc('answer',oldInput);eq(old.awardPoints,1000);await submit(first,1,false);await submit(first,2,false);
  const before=(await pool.query('SELECT to_jsonb(p) v FROM target_private.profiles p ORDER BY member_id')).rows;
  const oldAnswers=(await pool.query('SELECT to_jsonb(a) v FROM target_private.answers a ORDER BY quiz_id,question_id')).rows;
  await pool.query(await fs.readFile(path.join(dir,migration),'utf8'));
  const after=(await pool.query("SELECT to_jsonb(p)-'reward_miss_streak'-'reward_correct_streak'-'reward_locked' v FROM target_private.profiles p ORDER BY member_id")).rows;eq(after,before,'Activation never rewrites old score, money, bonus or progress');
  eq((await pool.query('SELECT to_jsonb(a) v FROM target_private.answers a ORDER BY quiz_id,question_id')).rows,oldAnswers,'Accepted answer history remains byte-equivalent');
  eq((await rpc('profile',a)).rewardLock,gate(),'Historical mistakes do not retroactively activate the new rule');
  eq(await rpc('answer',oldInput),old,'Old answer replay retains its exact historic award and metadata');eq(await rpc('answer',{...oldInput,requestId:uuid()}),old,'Old alternate-ID replay does not advance the account gate');
  let r=await submit(first,3);eq(r.awardPoints,1000);eq(r.rewardLock,gate());
  r=await submit(first,4,false);eq(r.rewardLock,gate(false,1));eq(r.awardPoints,0);
  r=await submit(first,5,false);eq(r.rewardLock,gate(true,2));eq(r.awardPoints,0);
  const other=await begin(b);r=await submit(other,0);eq(r.awardPoints,1000);eq(r.rewardLock,gate(),'Another account continues earning');
  r=await submit(first,6);eq(r.awardPoints,0);eq(r.rewardLock,gate(true,2,1));
  const mastery=(await pool.query('SELECT correct_streak FROM target_private.word_mastery WHERE member_id=$1 AND book=$2 AND word_number=$3',[a.memberId,'target1900',first.questions[6].number])).rows[0];ok(mastery.correct_streak>=1,'A zero-point recovery answer still contributes to learning mastery');
  r=await submit(first,7);eq(r.awardPoints,0);eq(r.rewardLock,gate(true,2,2));
  r=await submit(first,8,false);eq(r.rewardLock,gate(true,2,0));eq(r.awardPoints,0,'A recovery mistake clears only the correct streak');
  for(let i=9;i<=11;i++){r=await submit(first,i);eq(r.awardPoints,0,'Every recovery answer including the third earns zero');eq(r.rewardLock,i===11?gate():gate(true,2,i-8));}
  r=await submit(first,12);eq(r.awardPoints,1000,'The answer after the third recovery success earns normally');
  const bonusId=uuid(),starts=new Date(),ends=new Date(starts.getTime()+15900);await pool.query('UPDATE target_private.profiles SET bonus_id=$2,bonus_started_at=$3,bonus_ends_at=$4 WHERE member_id=$1',[a.memberId,bonusId,starts,ends]);
  await submit(first,13,false);await submit(first,14,false);
  await pool.query("CREATE OR REPLACE FUNCTION target_private.reward_points_for_roll(p_roll integer) RETURNS integer LANGUAGE plpgsql IMMUTABLE STRICT SECURITY INVOKER SET search_path=pg_catalog AS $$ BEGIN RAISE EXCEPTION 'Locked or bonus answers must not draw'; END $$");
  for(let i=15;i<=17;i++){r=await submit(first,i);eq(r.awardPoints,0);eq(r.bonus.id,bonusId);eq(Date.parse(r.bonus.endsAt),Math.floor(ends.getTime()/1),'The existing bonus is not restarted or extended');}
  r=await submit(first,18);eq(r.awardPoints,500,'After unlock the existing bonus pays500 without invoking RNG');
  await pool.query("UPDATE target_private.profiles SET bonus_id=NULL,bonus_started_at=NULL,bonus_ends_at=NULL WHERE member_id=$1",[a.memberId]);await pool.query("CREATE OR REPLACE FUNCTION target_private.reward_points_for_roll(p_roll integer) RETURNS integer LANGUAGE sql IMMUTABLE STRICT SECURITY INVOKER SET search_path=pg_catalog AS 'SELECT 1000'");
  await submit(first,19,false);await submit(first,20,false);
  const second=await begin(a),third=await begin(a);eq(second.result.rewardLock,gate(true,2));eq(third.result.rewardLock,gate(true,2),'Changing quiz does not bypass the account lock');
  const concurrent=await Promise.all([submit(second,0),submit(third,0)]);eq(concurrent.map(v=>v.awardPoints),[0,0]);eq(concurrent.map(v=>v.rewardLock.recoveryStreak).sort(),[1,2]);
  eq((await state(a)).reward_correct_streak,2,'Independent quiz connections advance one shared account streak');
  const thirdRecovery=input(second,1),copies=await Promise.all(Array.from({length:20},()=>rpc('answer',thirdRecovery)));for(const v of copies)eq(v,copies[0],'Concurrent duplicate IDs all return the same immutable answer');eq(copies[0].awardPoints,0);eq(copies[0].rewardLock,gate());
  const afterReplay=await state(a);eq(await rpc('answer',{...thirdRecovery,requestId:uuid()}),copies[0]);eq(await state(a),afterReplay,'Alternate retries do not advance streak, scores or money');
  r=await submit(second,2);eq(r.awardPoints,1000);
  const newWrong=input(second,3,false),beforeRejected=await state(a),system=(await pool.query('SELECT answer_count FROM target_private.system_state WHERE singleton')).rows[0];
  await pool.query('UPDATE target_private.system_state SET answer_count=200000 WHERE singleton');r=await rpc('answer',newWrong);eq(r.error.code,'CAPACITY_LIMIT');eq(await state(a),beforeRejected,'A rejected answer does not move any streak');await pool.query('UPDATE target_private.system_state SET answer_count=$1 WHERE singleton',[system.answer_count]);
  const countBefore=(await pool.query('SELECT count(*)::integer n FROM target_private.answers')).rows[0].n;
  r=await rpc('answer',{...newWrong,choiceId:uuid()});eq(r.error.code,'INVALID_CHOICE');eq(await state(a),beforeRejected);eq((await pool.query('SELECT count(*)::integer n FROM target_private.answers')).rows[0].n,countBefore);
  r=await rpc('answer',newWrong);eq(r.rewardLock,gate(false,1));r=await submit(second,4);eq(r.rewardLock,gate());eq(r.awardPoints,1000,'A normal correct answer breaks the pre-lock mistake streak');
  const sums=(await pool.query('SELECT p.member_id,p.total_points::text,coalesce(sum(a.award_points),0)::text awards FROM target_private.profiles p LEFT JOIN target_private.answers a USING(member_id) GROUP BY p.member_id ORDER BY p.member_id')).rows;for(const row of sums)eq(row.total_points,row.awards,'Lifetime income equals accepted actual awards');
  const attrs=(await pool.query("SELECT has_function_privilege('anon','target_private.reward_lock_snapshot(uuid)','EXECUTE') anon,has_function_privilege('authenticated','target_private.reward_lock_snapshot(uuid)','EXECUTE') authenticated,has_function_privilege('service_role','target_private.reward_lock_snapshot(uuid)','EXECUTE') service")).rows[0];eq(attrs,{anon:false,authenticated:false,service:false});
  await assert.rejects(pool.query('UPDATE target_private.profiles SET reward_miss_streak=3 WHERE member_id=$1',[a.memberId]),e=>e.code==='23514');checks++;
  await assert.rejects(pool.query('UPDATE target_private.profiles SET reward_correct_streak=1 WHERE member_id=$1',[a.memberId]),e=>e.code==='23514');checks++;
  console.log(JSON.stringify({rewardLockDatabase:'passed',checks,accountWide:true,recoveryThirdZero:true,replaysStable:true,bonusCannotBypass:true,hostedWrites:false}));
 }finally{await pool.end();}
})().catch(e=>{console.error('Reward lock verification failed: '+e.name+' '+e.message.replace(/\s+/g,' ').slice(0,220));process.exitCode=1;});
