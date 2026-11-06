'use strict';
// Standalone real PostgreSQL checks. Never run against a cloud or class DB.
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs/promises'),path=require('node:path');
const {Client,Pool}=require('pg');
const {generateQuestions}=require('../server/questions.cjs');
const root=path.resolve(__dirname,'..'),source=new URL(process.env.DATABASE_URL||'');
assert.equal(process.env.NODE_ENV,'test');assert(['localhost','127.0.0.1','[::1]'].includes(source.hostname));
source.pathname='/target_wallet_test';
const db=new Pool({connectionString:source.href,max:8}),uuid=()=>crypto.randomUUID(),secret=crypto.randomBytes(32).toString('base64url');
let checks=0;const check=(v,message)=>{checks++;assert(v,message);},eq=(a,b,message)=>{checks++;assert.deepEqual(a,b,message);};
const member=(name)=>({memberId:uuid(),name}),a=member('残高確認A'),b=member('残高確認B'),c=member('残高確認C'),earner=member('残高確認D');
const shop=(action,input,key=secret)=>db.query('SELECT public.target_shop_rpc($1,$2,$3::jsonb) AS value',[key,action,JSON.stringify(input)]).then(r=>r.rows[0].value);
const rpc=(action,input)=>db.query('SELECT public.target_rpc($1,$2,$3::jsonb) AS value',[secret,action,JSON.stringify(input)]).then(r=>r.rows[0].value);
async function seed(m,points){await db.query(`INSERT INTO target_private.profiles(member_id,name,total_points,correct_count,answered_count)
 VALUES($1,$2,$3::bigint,ceil($3::numeric/10000)::bigint,ceil($3::numeric/10000)::bigint)`,[m.memberId,m.name,points]);}
async function fingerprints(){return(await db.query(`SELECT md5(pg_get_functiondef('public.target_rpc(text,text,jsonb)'::regprocedure)) AS rpc,
 md5(pg_get_functiondef('target_private.reward_points_for_roll(integer)'::regprocedure)) AS odds`)).rows[0];}
(async()=>{
 let succeeded=false;
 try{
  const adminURL=new URL(source.href);adminURL.pathname='/postgres';const admin=new Client({connectionString:adminURL.href});await admin.connect();
  try{await admin.query('DROP DATABASE IF EXISTS target_wallet_test WITH (FORCE)');await admin.query('CREATE DATABASE target_wallet_test');}finally{await admin.end();}
  const files=(await fs.readdir(path.join(root,'supabase/migrations'))).filter(n=>/^\d+_.*\.sql$/.test(n)).sort(),newFile=files.find(n=>n.endsWith('_target_sticker_wallet.sql'));
  assert(newFile,'The generated wallet migration exists');
  for(const filename of files.filter(n=>n!==newFile))await db.query(await fs.readFile(path.join(root,'supabase/migrations',filename),'utf8'));
  await db.query("INSERT INTO target_private.server_credentials(singleton,key_hash) VALUES(true,encode(sha256(convert_to($1,'UTF8')),'hex'))",[secret]);
  await seed(a,100000);await seed(b,40000);await seed(c,10000);await seed(earner,9900);
  const old=await fingerprints(),incomeBefore=(await db.query('SELECT member_id,total_points,updated_at FROM target_private.profiles ORDER BY member_id')).rows;
  await db.query(await fs.readFile(path.join(root,'supabase/migrations',newFile),'utf8'));
  eq(await fingerprints(),old,'Old quiz RPC and reward odds are unchanged');
  eq((await db.query('SELECT member_id,total_points,updated_at FROM target_private.profiles ORDER BY member_id')).rows,incomeBefore,'Migration leaves income and ranking dates intact');
  eq((await db.query('SELECT count(*)::int AS n FROM target_private.sticker_draws')).rows[0].n,0,'No existing profile gets a free sticker');
  const countsBefore=(await db.query('SELECT count(*)::int AS n FROM target_private.profiles')).rows[0].n;
  eq((await shop('wallet',null,'invalid-credential')).error.code,'RPC_FORBIDDEN');
  eq((await shop('draw',{memberId:uuid(),name:'不正',requestId:uuid()},'invalid-credential')).error.status,403);
  eq((await db.query('SELECT count(*)::int AS n FROM target_private.profiles')).rows[0].n,countsBefore,'Rejected credentials allocate no profiles');
  for(const body of [{...a,balance:100000},{...a,memberId:'bad'},{...a,name:null},{...a,stickerId:'youth'}])eq((await shop('wallet',body)).error.code,'INVALID_REQUEST');
  const fresh=member('新規');eq(await shop('wallet',fresh),{balance:0,totalIncome:0,spent:0,price:10000,ownedStickers:[]});
  eq((await shop('draw',{...earner,requestId:uuid()})).error.code,'INSUFFICIENT_BALANCE');
  eq((await shop('wallet',earner)).spent,0,'Insufficient funds never debit');
  const requestId=uuid(),same=await Promise.all([shop('draw',{...a,requestId}),shop('draw',{...a,requestId})]);
  eq(same[0],same[1],'Concurrent retries preserve one result and one debit');
  eq(same[0].balance,90000);eq(same[0].totalIncome,100000);eq(same[0].spent,10000);eq(same[0].ownedStickers.length,1);
  const rankingBefore=await rpc('ranking',{}),datesBefore=(await db.query('SELECT member_id,updated_at FROM target_private.profiles ORDER BY member_id')).rows;
  const draws=await Promise.all(Array.from({length:5},()=>shop('draw',{...b,requestId:uuid()})));
  eq(draws.filter(v=>!v.error).length,4);eq(draws.filter(v=>v.error?.code==='COLLECTION_COMPLETE').length,1);
  const complete=await shop('wallet',b);eq(complete,{balance:0,totalIncome:40000,spent:40000,price:10000,ownedStickers:['youth','sunglasses','night','love']});
  eq((await rpc('ranking',{})).ranking,rankingBefore.ranking,'Spending does not lower income or change ranking order');
  eq((await db.query('SELECT member_id,updated_at FROM target_private.profiles ORDER BY member_id')).rows,datesBefore,'Spending does not change ranking dates');
  const races=await Promise.all([shop('draw',{...c,requestId:uuid()}),shop('draw',{...c,requestId:uuid()})]);
  eq(races.filter(v=>!v.error).length,1);eq(races.filter(v=>v.error?.code==='INSUFFICIENT_BALANCE').length,1);
  eq((await shop('wallet',c)).balance,0,'Concurrent clients cannot overspend');
  const questions=generateQuestions({book:'target1900',direction:'english',count:10,from:1,to:10,requestId:uuid()});
  const quiz=await rpc('start',{...earner,requestId:uuid(),book:'target1900',direction:'english',from:1,to:10,questions});check(!quiz.error,'Quiz still starts after wallet migration');
  const answerInput={...earner,quizId:quiz.quizId,questionId:questions[0].id,choiceId:questions[0].correctChoiceId,requestId:uuid()};
  const competingRequest=uuid(),[answer,competingDraw]=await Promise.all([rpc('answer',answerInput),shop('draw',{...earner,requestId:competingRequest})]);
  check(answer.correct&&[100,500,1000,10000,100000].includes(answer.awardPoints),'The authoritative answer RPC awards new income');
  const incomeAfter=9900+answer.awardPoints,walletAfter=await shop('wallet',earner);
  eq(walletAfter.totalIncome,incomeAfter);eq(walletAfter.balance+walletAfter.spent,incomeAfter);
  if(competingDraw.error){eq(competingDraw.error.code,'INSUFFICIENT_BALANCE');const recovered=await shop('draw',{...earner,requestId:competingRequest});check(!recovered.error,'A failed insufficient attempt can succeed once income arrives');}
  eq((await shop('wallet',earner)).spent,10000,'Concurrent award and draw debit exactly once');eq(await rpc('answer',answerInput),answer,'Old answer replay remains unchanged after spending');
  const first=draws.find(v=>!v.error);eq((await shop('draw',{...b,requestId:first.requestId})).stickerId,first.stickerId,'Replay works even after the collection becomes complete');
  const quota=(await db.query('SELECT logical_bytes FROM target_private.system_state WHERE singleton')).rows[0].logical_bytes;
  await db.query('UPDATE target_private.system_state SET logical_bytes=104857600 WHERE singleton');
  eq((await shop('draw',{...a,requestId:uuid()})).error.code,'CAPACITY_LIMIT');eq((await shop('wallet',a)).spent,10000,'Capacity failure keeps funds intact');
  await db.query('UPDATE target_private.system_state SET logical_bytes=$1 WHERE singleton',[quota]);
  await assert.rejects(db.query('UPDATE target_private.profiles SET spent_points=total_points+10000 WHERE member_id=$1',[a.memberId]),e=>e.code==='23514');checks++;
  const access=(await db.query(`SELECT c.relrowsecurity,has_table_privilege('anon',c.oid,'SELECT') AS anon_read,
   has_function_privilege('anon','public.target_shop_rpc(text,text,jsonb)','EXECUTE') AS anon_rpc,
   has_function_privilege('authenticated','public.target_shop_rpc(text,text,jsonb)','EXECUTE') AS authenticated_rpc,
   has_schema_privilege('anon','target_private','USAGE') AS schema_usage
   FROM pg_class c WHERE c.oid='target_private.sticker_draws'::regclass`)).rows[0];
  eq(access,{relrowsecurity:true,anon_read:false,anon_rpc:true,authenticated_rpc:false,schema_usage:false});
  const anonymous=await db.connect();try{await anonymous.query('SET ROLE anon');const rejected=await anonymous.query("SELECT public.target_shop_rpc('bad','wallet','{}') AS value");eq(rejected.rows[0].value.error.code,'RPC_FORBIDDEN');await assert.rejects(anonymous.query('SELECT * FROM target_private.sticker_draws'),e=>e.code==='42501');checks++;}finally{await anonymous.query('RESET ROLE');anonymous.release();}
  const existing=(await db.query('SELECT count(*)::int AS n FROM target_private.profiles')).rows[0].n;
  await db.query("INSERT INTO target_private.profiles(member_id,name) SELECT gen_random_uuid(),'容量検証' FROM generate_series(1,$1::integer)",[500-existing]);
  eq((await shop('wallet',member('上限'))).error.code,'CAPACITY_LIMIT');
  succeeded=true;
  console.log(JSON.stringify({walletDatabase:'passed',checks,concurrencyVerified:true,oldRpcUnchanged:true,cloudVerified:false}));
 }finally{
  await db.end();await fs.mkdir(path.join(root,'test-results'),{recursive:true});await fs.writeFile(path.join(root,'test-results/shop-db-results.json'),JSON.stringify({walletDatabase:succeeded?'passed':'failed',checks,cloudVerified:false})+'\n');
 }
})().catch(error=>{console.error('Wallet DB verification failed: '+error.name+' '+error.message.replace(/\s+/g,' ').slice(0,180));process.exitCode=1;});
