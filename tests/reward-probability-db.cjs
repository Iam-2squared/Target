'use strict';
// Actual migration and scorer over a fresh loopback PostgreSQL database.
// guestAward is evaluated from the shipped app source with deterministic entropy.
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs/promises'),path=require('node:path'),vm=require('node:vm');
const {Client}=require('pg'),{generateQuestions}=require('../server/questions.cjs');
const root=path.resolve(__dirname,'..'),source=new URL(process.env.DATABASE_URL||'');
assert.equal(process.env.NODE_ENV,'test');assert(['localhost','127.0.0.1','[::1]'].includes(source.hostname),'Only loopback test databases are allowed.');
const name='target_reward_probability_new_test',migration='20261108023703_target_reward_probability_two_seven_twenty.sql',adminURL=new URL(source),url=new URL(source);adminURL.pathname='/postgres';url.pathname='/'+name;
const secret=crypto.randomBytes(32).toString('hex'),memberId=crypto.randomUUID(),person={memberId,name:'確率変更の検証'},uuid=()=>crypto.randomUUID();
let checks=0;const eq=(a,b,label)=>{checks++;assert.deepEqual(a,b,label);},ok=(a,label)=>{checks++;assert(a,label);};
(async()=>{
 const admin=new Client({connectionString:adminURL.href});await admin.connect();try{await admin.query('DROP DATABASE IF EXISTS '+name+' WITH (FORCE)');await admin.query('CREATE DATABASE '+name);}finally{await admin.end();}
 const db=new Client({connectionString:url.href});await db.connect();
 try{
  const dir=path.join(root,'supabase/migrations');for(const file of (await fs.readdir(dir)).filter(file=>file.endsWith('.sql')&&file<migration).sort())await db.query(await fs.readFile(path.join(dir,file),'utf8'));
  await db.query('INSERT INTO target_private.server_credentials(singleton,key_hash) VALUES(true,$1)',[crypto.createHash('sha256').update(secret).digest('hex')]);
  const rpc=async(action,input={})=>(await db.query('SELECT public.target_rpc($1,$2,$3::jsonb) AS value',[secret,action,JSON.stringify(input)])).rows[0].value;
  const definition=async name=>(await db.query('SELECT pg_get_functiondef($1::regprocedure) AS value',[name])).rows[0].value;
  const attrs=async name=>(await db.query('SELECT oid,proowner,prosecdef,proisstrict,provolatile,proconfig,proacl::text AS acl FROM pg_proc WHERE oid=$1::regprocedure',[name])).rows[0];
  const fn='target_private.reward_points_for_roll(integer)',beforeFunction=await definition(fn),beforeAttrs=await attrs(fn),beforeScorer=await definition('public.target_rpc(text,text,jsonb)'),beforeBonus=await definition('target_private.bonus_snapshot(uuid)');
  eq((await db.query('SELECT target_private.reward_points_for_roll(i) AS award,count(*)::int AS n FROM generate_series(0,99)i GROUP BY award ORDER BY award')).rows,[{award:100,n:82},{award:1000,n:15},{award:10000,n:2},{award:100000,n:1}],'The prior deployed distribution is the starting point');
  const questions=generateQuestions({book:'target1900',direction:'english',count:10,from:1,to:100,requestId:uuid()});
  const quiz=await rpc('start',{...person,requestId:uuid(),book:'target1900',direction:'english',from:1,to:100,questions});ok(quiz.quizId,'A real scorer quiz starts');
  const input=(index,correct=true)=>({...person,quizId:quiz.quizId,questionId:questions[index].id,choiceId:correct?questions[index].correctChoiceId:questions[index].choices.find(choice=>choice.id!==questions[index].correctChoiceId).id,requestId:uuid()});
  // Save a deterministic pre-change receipt, then restore the real prior mapper.
  await db.query("CREATE OR REPLACE FUNCTION target_private.reward_points_for_roll(p_roll integer) RETURNS integer LANGUAGE sql IMMUTABLE STRICT SECURITY INVOKER SET search_path=pg_catalog AS 'SELECT 1000'");
  const oldInput=input(0),oldReceipt=await rpc('answer',oldInput);eq(oldReceipt.awardPoints,1000);await db.query(beforeFunction);
  const snapshot=async()=>({profiles:(await db.query('SELECT to_jsonb(p) AS row FROM target_private.profiles p ORDER BY member_id')).rows,quizzes:(await db.query('SELECT to_jsonb(q) AS row FROM target_private.quizzes q ORDER BY id')).rows,answers:(await db.query('SELECT to_jsonb(a) AS row FROM target_private.answers a ORDER BY quiz_id,question_id')).rows});
  const before=await snapshot();await db.query(await fs.readFile(path.join(dir,migration),'utf8'));
  eq(await snapshot(),before,'Applying the mapping migration never rewrites stored awards, income or progress');
  eq(await attrs(fn),beforeAttrs,'Function identity, owner, private ACL, volatility, strictness, invoker and search_path remain identical');
  eq(await definition('public.target_rpc(text,text,jsonb)'),beforeScorer,'The scorer and replay control flow are unchanged');eq(await definition('target_private.bonus_snapshot(uuid)'),beforeBonus,'The bonus window remains unchanged');
  eq(await rpc('answer',oldInput),oldReceipt,'Same-ID replay preserves the accepted old award');eq(await rpc('answer',{...oldInput,requestId:uuid()}),oldReceipt,'Another request ID for the accepted answer also preserves the award');
  const mapping=(await db.query('SELECT i,target_private.reward_points_for_roll(i) AS award FROM generate_series(0,99)i ORDER BY i')).rows;
  const expected=Array.from({length:100},(_,roll)=>roll<=1?100000:roll<=8?10000:roll<=28?1000:100);eq(mapping.map(row=>row.award),expected,'Every new DB outcome matches the specified inclusive ranges');
  eq((await db.query('SELECT target_private.reward_points_for_roll(i) AS award,count(*)::int AS n FROM generate_series(0,99)i GROUP BY award ORDER BY award')).rows,[{award:100,n:71},{award:1000,n:20},{award:10000,n:7},{award:100000,n:2}],'Exact 2/7/20/71 probabilities');
  eq((await db.query('SELECT i,target_private.reward_points_for_roll(i) AS award FROM unnest(ARRAY[-1,0,1,2,8,9,28,29,99,100])i ORDER BY i')).rows,[{i:-1,award:null},{i:0,award:100000},{i:1,award:100000},{i:2,award:10000},{i:8,award:10000},{i:9,award:1000},{i:28,award:1000},{i:29,award:100},{i:99,award:100},{i:100,award:null}],'All range edges and invalid rolls');
  eq((await db.query('SELECT target_private.reward_points_for_roll(NULL) AS missing')).rows[0],{missing:null},'STRICT null input is retained');
  eq((await db.query("SELECT has_function_privilege('anon','target_private.reward_points_for_roll(integer)','execute') AS anon,has_function_privilege('authenticated','target_private.reward_points_for_roll(integer)','execute') AS authenticated")).rows[0],{anon:false,authenticated:false},'API roles cannot execute the private helper');
  await db.query('SET ROLE anon');let denied=false;try{await db.query('SELECT target_private.reward_points_for_roll(0)')}catch(error){denied=error.code==='42501';}finally{await db.query('RESET ROLE');}ok(denied,'anon cannot invoke the private function');
  const app=await fs.readFile(path.join(root,'public/app.js'),'utf8'),guest=app.match(/function guestAward\(\) \{[\s\S]*?\n  \}/u);ok(guest,'The actual guest mapper is located');
  for(let roll=0;roll<100;roll++){const award=vm.runInNewContext('('+guest[0]+')()',{Uint32Array,crypto:{getRandomValues(array){array[0]=roll;return array;}}});eq(award,mapping[roll].award,'Actual guest source and DB agree for roll '+roll);}
  let entropyCalls=0;eq(vm.runInNewContext('('+guest[0]+')()',{Uint32Array,crypto:{getRandomValues(array){array[0]=entropyCalls++===0?0xffffffff:8;return array;}}}),10000,'Guest entropy rejects values outside the unbiased range');eq(entropyCalls,2);
  const fresh=await rpc('answer',input(1));ok([100,1000,10000,100000].includes(fresh.awardPoints),'A new correct answer uses a valid updated award');eq(fresh.totalPoints,oldReceipt.totalPoints+fresh.awardPoints,'New correct income adds once');
  const wrong=await rpc('answer',input(2,false));eq(wrong.awardPoints,0,'Wrong answers remain zero');eq(wrong.totalPoints,fresh.totalPoints,'Wrong answers do not change income');
  // A live server bonus bypasses the normal mapper, regardless of the new odds.
  await db.query("UPDATE target_private.profiles SET bonus_id=$2,bonus_started_at=now(),bonus_ends_at=now()+interval '15.9 seconds' WHERE member_id=$1",[memberId,uuid()]);
  const savedMapper=await definition(fn);await db.query("CREATE OR REPLACE FUNCTION target_private.reward_points_for_roll(p_roll integer) RETURNS integer LANGUAGE plpgsql IMMUTABLE STRICT SECURITY INVOKER SET search_path=pg_catalog AS $$ BEGIN RAISE EXCEPTION 'A bonus answer must not draw'; END $$");
  const bonusInput=input(3),bonusReceipt=await rpc('answer',bonusInput);eq(bonusReceipt.awardPoints,500,'Bonus correct answers still pay exactly500 without drawing');eq(bonusReceipt.bonus.durationMs,15900,'Bonus duration stays15.9seconds');eq(await rpc('answer',bonusInput),bonusReceipt,'Bonus answer replay stays stable');await db.query(savedMapper);
  const report={status:'passed',checks,mapping:{100:71,1000:20,10000:7,100000:2},guestMatchesAll100:true,historyAndReplayPreserved:true,privateAttributesPreserved:true,scorerUnchanged:true,bonus500And15900msPreserved:true,hostedWrites:0};await fs.mkdir(path.join(root,'test-results'),{recursive:true});await fs.writeFile(path.join(root,'test-results/reward-probability-results.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
 }finally{await db.end();}
})().catch(error=>{console.error(error.name+': '+error.message);process.exitCode=1;});
