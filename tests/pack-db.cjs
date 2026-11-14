'use strict';
// Real PostgreSQL, synthetic members only. Never use a hosted or shared DB.
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs/promises'),path=require('node:path');
const {Client,Pool}=require('pg'),{generateQuestions}=require('../server/questions.cjs');
const root=path.resolve(__dirname,'..'),url=new URL(process.env.DATABASE_URL||'');
assert.equal(process.env.NODE_ENV,'test');assert(['localhost','127.0.0.1','[::1]'].includes(url.hostname));url.pathname='/target_pack_test';
const db=new Pool({connectionString:url.href,max:8}),uuid=()=>crypto.randomUUID(),secret=crypto.randomBytes(32).toString('base64url');
const catalog=['youth','sunglasses','night','love','goodnight','hang-in-there','can-you-hear','go','sleepy','screenshot','love-first','no-showoff','chuckle','red-face','whoa','secret','how-about-it'];
const legacy=catalog.slice(0,4),migration='20261106113132_target_sticker_pack_seventeen.sql',priceFile='20261106095438_target_gacha_hundred_thousand.sql';
let checks=0,phase='setup',passed=false;const ok=(v,label)=>{checks++;assert(v,label);},eq=(a,b,label)=>{checks++;assert.deepEqual(a,b,label);};
const person=name=>({memberId:uuid(),name}),a=person('旧四種確認A'),b=person('新規確認B'),c=person('同時確認C'),q=person('容量確認Q'),old=person('旧処理確認D'),earner=person('採点確認E');
const shop=(action,input,key=secret,connection=db)=>connection.query('SELECT public.target_shop_rpc($1,$2,$3::jsonb) AS value',[key,action,JSON.stringify(input)]).then(r=>r.rows[0].value);
const rpc=(action,input)=>db.query('SELECT public.target_rpc($1,$2,$3::jsonb) AS value',[secret,action,JSON.stringify(input)]).then(r=>r.rows[0].value);
const draw=(member,requestId=uuid(),options={})=>shop('draw',{...member,requestId,expectedPrice:100000,expectedCatalogVersion:2,...options});
async function seed(member,total){await db.query('INSERT INTO target_private.profiles(member_id,name,total_points,correct_count,answered_count) VALUES($1,$2,$3::bigint,ceil($3::numeric/10000),ceil($3::numeric/10000))',[member.memberId,member.name,total]);}
async function stable(){return(await db.query("SELECT md5(pg_get_functiondef('public.target_rpc(text,text,jsonb)'::regprocedure)) AS scorer,md5(pg_get_functiondef('target_private.reward_points_for_roll(integer)'::regprocedure)) AS odds,md5(pg_get_functiondef('target_private.record_word_mastery()'::regprocedure)) AS mastery,md5(pg_get_functiondef('target_private.enforce_gacha_price_protocol()'::regprocedure)) AS price")).rows[0];}
async function resetRate(member){await db.query('DELETE FROM target_private.rate_limits WHERE identifier=$1',['shop-draw:'+member.memberId]);}
(async()=>{
 try{
  const adminUrl=new URL(url.href);adminUrl.pathname='/postgres';const admin=new Client({connectionString:adminUrl.href});await admin.connect();try{await admin.query('DROP DATABASE IF EXISTS target_pack_test WITH (FORCE)');await admin.query('CREATE DATABASE target_pack_test');}finally{await admin.end();}
  const files=(await fs.readdir(path.join(root,'supabase/migrations'))).filter(n=>/^\d+_.*\.sql$/.test(n)).sort();
  for(const file of files.filter(n=>n<priceFile))await db.query(await fs.readFile(path.join(root,'supabase/migrations',file),'utf8'));
  await db.query("INSERT INTO target_private.server_credentials(singleton,key_hash) VALUES(true,encode(sha256(convert_to($1,'UTF8')),'hex'))",[secret]);
  await seed(a,2000000);await seed(b,2000000);await seed(c,100000);await seed(q,500000);await seed(old,500000);await seed(earner,99900);
  const historical=[];for(let i=0;i<4;i++){const input={...a,requestId:uuid()},value=await shop('draw',input);ok(!value.error,'Historical10k purchase uses actual old RPC');eq(value.price,10000);historical.push({input,value});}
  eq((await shop('wallet',a)).ownedStickers,legacy,'Historical four were completed before expansion');
  const rowsBefore=(await db.query('SELECT * FROM target_private.sticker_draws ORDER BY member_id,request_id')).rows;
  const profilesBefore=(await db.query('SELECT member_id,name,total_points,correct_count,answered_count,spent_points,updated_at FROM target_private.profiles ORDER BY member_id')).rows;
  for(const file of files.filter(n=>n>=priceFile&&n<migration))await db.query(await fs.readFile(path.join(root,'supabase/migrations',file),'utf8'));
  const fingerprint=await stable(),quotaBefore=Number((await db.query('SELECT logical_bytes FROM target_private.system_state WHERE singleton')).rows[0].logical_bytes);
  phase='queued old RPC through migration';const blocker=await db.connect(),waiter=await db.connect();let staleError;
  try{
   await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock(991101)');const pid=(await waiter.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
   const pending=shop('draw',{...old,requestId:uuid(),expectedPrice:100000},secret,waiter).then(()=>null,error=>error);
   let blocked=false;for(let i=0;i<100;i++){if((await blocker.query('SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted) AS waiting',[pid])).rows[0].waiting){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}
   ok(blocked,'An already executing original-catalog draw is waiting on991101');await blocker.query(await fs.readFile(path.join(root,'supabase/migrations',migration),'utf8'));await blocker.query('COMMIT');staleError=await pending;
  }finally{await blocker.query('ROLLBACK');blocker.release();waiter.release();}
  eq(staleError?.code,'42501','The persistent catalog guard rejects an old compiled body without any debit');
  eq((await db.query('SELECT * FROM target_private.sticker_draws ORDER BY member_id,request_id')).rows,rowsBefore,'Migration leaves all original receipts untouched');
  eq((await db.query('SELECT member_id,name,total_points,correct_count,answered_count,spent_points,updated_at FROM target_private.profiles ORDER BY member_id')).rows,profilesBefore,'Migration and rejected queued call preserve all income, spending and dates');
  eq(await stable(),fingerprint,'Scoring, mastery, odds and price guard remain unchanged');
  eq(Number((await db.query('SELECT logical_bytes FROM target_private.system_state WHERE singleton')).rows[0].logical_bytes)-quotaBefore,17*256,'Static catalog is charged once within the existing storage ceiling');
  eq((await db.query('SELECT id FROM target_private.sticker_catalog ORDER BY ordinal')).rows.map(r=>r.id),catalog,'One private canonical ordered catalog');
  const snap=await shop('wallet',a);eq(snap,{balance:1960000,totalIncome:2000000,spent:40000,price:100000,catalogVersion:2,catalogSize:17,ownedStickers:legacy});
  const replay=await shop('draw',historical[0].input);eq(replay.cost,10000);eq(replay.stickerId,historical[0].value.stickerId);eq(replay.catalogVersion,2);eq(replay.catalogSize,17);eq(replay.spent,40000);
  phase='version boundary';const before=(await shop('wallet',b)).balance;
  for(const version of [undefined,1]){const input={...b,requestId:uuid(),expectedPrice:100000,...(version===undefined?{}:{expectedCatalogVersion:version})};eq((await shop('draw',input)).error.code,'CATALOG_CHANGED');eq((await shop('wallet',b)).balance,before,'Old catalog acknowledgement cannot debit');}
  for(const version of [0,3,null,'2',{},[]])eq((await draw(b,uuid(),{expectedCatalogVersion:version})).error.code,'INVALID_REQUEST');
  eq((await shop('draw',{...b,requestId:uuid(),expectedCatalogVersion:2})).error.code,'PRICE_CHANGED','Catalog acknowledgement does not bypass price acknowledgement');
  const peopleBefore=(await db.query('SELECT count(*)::integer AS n FROM target_private.profiles')).rows[0].n;
  eq((await shop('wallet',{},'bad')).error.code,'RPC_FORBIDDEN');eq((await db.query('SELECT count(*)::integer AS n FROM target_private.profiles')).rows[0].n,peopleBefore,'Invalid secret allocates no member');
  for(const body of [{...b,balance:100000},{...b,role:'admin'},{...b,stickerId:'go'},{...b,ownerId:a.memberId}])eq((await shop('wallet',body)).error.code,'INVALID_REQUEST');
  phase='old complete gains thirteen';await resetRate(a);const newRequest=uuid(),simultaneous=await Promise.all([draw(a,newRequest),draw(a,newRequest)]);eq(simultaneous[0],simultaneous[1],'Concurrent same request has one result and debit');
  const newer=[simultaneous[0]];ok(catalog.slice(4).includes(newer[0].stickerId),'Four-item completion can receive a new sticker');
  for(let i=1;i<13;i++){if(i===7)await resetRate(a);const value=await draw(a);ok(!value.error,'A remaining new sticker is obtainable');newer.push(value);}
  eq(new Set(newer.map(v=>v.stickerId)).size,13,'Thirteen new results are distinct');eq(newer.map(v=>v.stickerId).sort(),catalog.slice(4).slice().sort(),'Only new items are drawn for an old complete account');
  const full=await shop('wallet',a);eq(full,{balance:660000,totalIncome:2000000,spent:1340000,price:100000,catalogVersion:2,catalogSize:17,ownedStickers:catalog});
  eq((await draw(a)).error.code,'COLLECTION_COMPLETE');eq((await shop('wallet',a)).spent,1340000,'No18th debit');
  eq((await draw(a,newRequest,{expectedCatalogVersion:1})).stickerId,newer[0].stickerId,'Saved modern request replays before stale version check');
  const oldAgain=await shop('draw',historical[0].input);eq(oldAgain.cost,10000);eq(oldAgain.spent,1340000);eq(oldAgain.ownedStickers,catalog,'Original10k receipt returns fresh seventeen-item ownership');
  phase='fresh and concurrent';const request=uuid(),one=await Promise.all([draw(b,request),draw(b,request)]);eq(one[0],one[1]);eq(one[0].spent,100000);
  const five=await Promise.all(Array.from({length:5},()=>draw(b)));eq(five.filter(v=>!v.error).length,5);eq(new Set([one[0],...five].map(v=>v.stickerId)).size,6,'Concurrent draws cannot duplicate an item');
  const race=await Promise.all([draw(c),draw(c)]);eq(race.filter(v=>!v.error).length,1);eq(race.filter(v=>v.error?.code==='INSUFFICIENT_BALANCE').length,1);eq((await shop('wallet',c)).balance,0,'Independent simultaneous requests cannot overspend');
  eq((await draw(earner)).error.code,'INSUFFICIENT_BALANCE');
  const questions=generateQuestions({book:'target1900',direction:'english',count:10,from:1,to:10,requestId:uuid()});const quiz=await rpc('start',{...earner,requestId:uuid(),book:'target1900',direction:'english',from:1,to:10,questions});ok(!quiz.error,'Learning continues after catalog expansion');
  const answer={...earner,quizId:quiz.quizId,questionId:questions[0].id,choiceId:questions[0].correctChoiceId,requestId:uuid()},drawId=uuid();
  const [receipt,purchase]=await Promise.all([rpc('answer',answer),draw(earner,drawId)]);ok(receipt.correct&&receipt.awardPoints>=100,'Authoritative scoring still works');
  if(purchase.error){eq(purchase.error.code,'INSUFFICIENT_BALANCE');ok(!(await draw(earner,drawId)).error,'A rejected insufficient attempt may succeed after income arrives');}
  const earned=await shop('wallet',earner);eq(earned.totalIncome,99900+receipt.awardPoints);eq(earned.spent,100000);eq(earned.balance+earned.spent,earned.totalIncome);eq(await rpc('answer',answer),receipt,'Answer replay never changes after purchasing');
  eq((await db.query('SELECT correct_streak FROM target_private.word_mastery WHERE member_id=$1 AND book=$2 AND word_number=$3',[earner.memberId,'target1900',questions[0].number])).rows[0].correct_streak,1,'Per-word mastery remains recorded');
  phase='quota and private boundary';const used=Number((await db.query('SELECT logical_bytes FROM target_private.system_state WHERE singleton')).rows[0].logical_bytes);await db.query('UPDATE target_private.system_state SET logical_bytes=104857600 WHERE singleton');eq((await draw(q)).error.code,'CAPACITY_LIMIT');eq((await shop('wallet',q)).spent,0,'Quota rejection preserves funds');await db.query('UPDATE target_private.system_state SET logical_bytes=$1 WHERE singleton',[used]);
  const integrity=await db.connect();try{await integrity.query('BEGIN');await integrity.query("SELECT set_config('target.gacha_price_protocol','100000',true),set_config('target.gacha_catalog_protocol','2',true)");await assert.rejects(integrity.query('INSERT INTO target_private.sticker_draws(member_id,request_id,sticker_id,cost) VALUES($1,$2,$3,100000)',[q.memberId,uuid(),'forged-item']),e=>e.code==='23503');checks++;}finally{await integrity.query('ROLLBACK');integrity.release();}
  const access=(await db.query("SELECT relrowsecurity,has_table_privilege('anon','target_private.sticker_catalog','SELECT') AS anon_select,has_table_privilege('authenticated','target_private.sticker_catalog','INSERT') AS authenticated_insert,has_function_privilege('anon','target_private.enforce_gacha_catalog_protocol()','EXECUTE') AS trigger_execute,has_schema_privilege('anon','target_private','USAGE') AS schema_usage FROM pg_class WHERE oid='target_private.sticker_catalog'::regclass")).rows[0];eq(access,{relrowsecurity:true,anon_select:false,authenticated_insert:false,trigger_execute:false,schema_usage:false});
  const anon=await db.connect();try{await anon.query('SET ROLE anon');eq((await shop('wallet',b,'bad',anon)).error.code,'RPC_FORBIDDEN');await assert.rejects(anon.query('SELECT * FROM target_private.sticker_catalog'),e=>e.code==='42501');checks++;}finally{await anon.query('RESET ROLE');anon.release();}
  eq((await db.query("SELECT count(*)::integer AS n FROM pg_indexes WHERE schemaname='target_private' AND indexname='target_sticker_draws_catalog_idx'")).rows[0].n,1,'Catalog foreign key is indexed');
  eq((await db.query('SELECT count(*)::integer AS n FROM target_private.profiles p WHERE spent_points IS DISTINCT FROM coalesce((SELECT sum(cost) FROM target_private.sticker_draws d WHERE d.member_id=p.member_id),0)')).rows[0].n,0,'Every profile remains coherent with immutable receipts');
  const reconnect=new Client({connectionString:url.href});await reconnect.connect();try{eq((await shop('wallet',a,secret,reconnect)).ownedStickers,catalog,'Ownership survives new database connections');}finally{await reconnect.end();}
  const hashes=(await db.query("SELECT md5(prosrc) AS md5,proname FROM pg_proc WHERE oid IN ('public.target_shop_rpc(text,text,jsonb)'::regprocedure,'target_private.wallet_snapshot(uuid)'::regprocedure,'target_private.enforce_gacha_catalog_protocol()'::regprocedure) ORDER BY proname")).rows;
  passed=true;console.log(JSON.stringify({packDatabase:'passed',checks,actualOldBodyGuard:true,historicalFourPreserved:true,newItems:13,catalogSize:17,hashes,cloudVerified:false}));
 }catch(error){console.error('Pack DB verification failed at '+phase+': '+(error.code||error.name)+' '+(error.stack||'').split('\n').filter(line=>line.includes('pack-db.cjs:')).at(-1));process.exitCode=1;}
 finally{await db.end();await fs.mkdir(path.join(root,'test-results'),{recursive:true});await fs.writeFile(path.join(root,'test-results/pack-db-results.json'),JSON.stringify({packDatabase:passed?'passed':'failed',phase,checks,cloudVerified:false})+'\n');}
})();
