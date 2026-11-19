'use strict';
// Local disposable PostgreSQL only. No hosted account or wager is used.
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs/promises'),path=require('node:path');
const {Client,Pool}=require('pg'),games=require('../server/games.cjs');
assert.equal(process.env.NODE_ENV,'test');
const url=new URL(process.env.DATABASE_URL||'');assert(['localhost','127.0.0.1','[::1]'].includes(url.hostname));url.pathname='/target_plinko_hundred_owner_test';
const db=new Pool({connectionString:url.href,max:12}),uuid=()=>crypto.randomUUID(),secret=crypto.randomBytes(32).toString('base64url');
const member=name=>({memberId:uuid(),name}),a=member('百玉検証'),giant=member('最大額百玉'),poor=member('全額不足'),near=member('収益上限'),fail=member('途中障害'),storage=member('容量検証');
let checks=0;const eq=(a,b,message)=>{checks++;assert.deepEqual(a,b,message);};
const rpc=(action,input)=>db.query('SELECT public.target_games_rpc($1,$2,$3::jsonb) AS v',[secret,action,JSON.stringify(input)]).then(r=>r.rows[0].v);
const batch=(m,more={})=>({...m,requestId:uuid(),game:'plinko',stake:100,choice:null,rulesVersion:4,count:100,...more});
const snap=m=>rpc('snapshot',{memberId:m.memberId});
const quota=async m=>(await db.query("SELECT coalesce(sum(attempt_count),0)::integer n FROM target_private.rate_limits WHERE identifier=$1 AND expires_at>clock_timestamp()",['games-play:'+m.memberId])).rows[0].n;
const count=async(table,m)=>(await db.query('SELECT count(*)::integer n FROM target_private.'+table+' WHERE member_id=$1',[m.memberId])).rows[0].n;
async function seed(m,amount=10000000){await db.query('INSERT INTO target_private.profiles(member_id,name,total_points,correct_count,answered_count) VALUES($1,$2,$3::bigint,ceil($3::bigint::numeric/100000),ceil($3::bigint::numeric/100000))',[m.memberId,m.name,amount]);}
async function hashReceipts(){return(await db.query("SELECT md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.member_id,r.request_id)::text,'[]')) hash FROM target_private.casino_rounds r")).rows[0].hash;}
async function forceBin(bin,failAt=null){await db.query('ALTER SEQUENCE target_private.hundred_test_rng RESTART WITH 0');await db.query("CREATE OR REPLACE FUNCTION target_private.secure_random_int(p_bound integer) RETURNS integer LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$ DECLARE n bigint; BEGIN IF p_bound<>2 THEN RAISE EXCEPTION 'Unexpected entropy domain'; END IF; n:=nextval('target_private.hundred_test_rng');"+(failAt===null?'':" IF n>="+failAt+" THEN RAISE EXCEPTION 'Injected hundred-ball entropy failure'; END IF;")+" RETURN CASE WHEN n%16<"+bin+" THEN 1 ELSE 0 END; END $$");}
(async()=>{try{
 const adminURL=new URL(url.href);adminURL.pathname='/postgres';const admin=new Client({connectionString:adminURL.href});await admin.connect();
 try{await admin.query('DROP DATABASE IF EXISTS target_plinko_hundred_owner_test WITH (FORCE)');await admin.query('CREATE DATABASE target_plinko_hundred_owner_test');}finally{await admin.end();}
 const dir=path.resolve(__dirname,'../supabase/migrations'),files=(await fs.readdir(dir)).filter(n=>/^\d+.*\.sql$/.test(n)).sort(),latest=files.find(n=>n.endsWith('_target_plinko_hundred_ball_batches.sql'));assert(latest);
 for(const file of files.filter(n=>n<latest))await db.query(await fs.readFile(path.join(dir,file),'utf8'));
 await db.query("INSERT INTO target_private.server_credentials(singleton,key_hash) VALUES(true,encode(sha256(convert_to($1,'UTF8')),'hex'))",[secret]);
 await seed(a);await seed(giant);await seed(poor,9999900);await seed(fail);await seed(storage);
 await db.query('CREATE SEQUENCE target_private.hundred_test_rng MINVALUE 0 START 0');await forceBin(8);
 const oldInput=batch(a,{count:20}),old=await rpc('batch',oldInput),before=await snap(a),receiptHash=await hashReceipts();eq(old.batch.count,20);
 const originalRate=(await db.query("SELECT md5(pg_get_functiondef('target_private.consume_rate(text,integer,integer)'::regprocedure)) h")).rows[0].h;
 const untouched=(await db.query("SELECT jsonb_object_agg(p.proname,md5(pg_get_functiondef(p.oid))) h FROM pg_proc p WHERE p.oid IN('public.target_rpc(text,text,jsonb)'::regprocedure,'public.target_shop_rpc(text,text,jsonb)'::regprocedure,'target_private.wallet_snapshot(uuid)'::regprocedure,'target_private.wallet_finance_projection(timestamptz)'::regprocedure,'target_private.secure_random_int(integer)'::regprocedure)")).rows[0].h;
 await db.query(await fs.readFile(path.join(dir,latest),'utf8'));
 eq(await hashReceipts(),receiptHash,'Widening constraints leaves every old receipt exact');eq(await snap(a),before);
 eq((await rpc('batch',oldInput)).batch,old.batch,'Existing twenty-ball UUID replays identically');
 eq((await db.query("SELECT md5(pg_get_functiondef('target_private.consume_rate(text,integer,integer)'::regprocedure)) h")).rows[0].h,originalRate);
 eq((await db.query("SELECT jsonb_object_agg(p.proname,md5(pg_get_functiondef(p.oid))) h FROM pg_proc p WHERE p.oid IN('public.target_rpc(text,text,jsonb)'::regprocedure,'public.target_shop_rpc(text,text,jsonb)'::regprocedure,'target_private.wallet_snapshot(uuid)'::regprocedure,'target_private.wallet_finance_projection(timestamptz)'::regprocedure,'target_private.secure_random_int(integer)'::regprocedure)")).rows[0].h,untouched,'Quiz gates, inventory tombstones, money projection and entropy helper stay unchanged');
 await db.query('DELETE FROM target_private.rate_limits WHERE identifier=$1',['games-play:'+a.memberId]);await forceBin(8);
 const input=batch(a),prior=await snap(a),copies=await Promise.all(Array.from({length:30},()=>rpc('batch',input))),result=copies[0];for(const value of copies)eq(value,result);
 games.parseResponse('batch',result,games.parseInput('batch',input));checks++;
 eq(result.batch.count,100);eq(result.batch.totalStake,10000);eq(result.batch.totalPayout,2000);eq(result.batch.net,-8000);eq(result.wallet.totalIncome,prior.totalIncome-8000);eq(result.wallet.walletRevision,prior.walletRevision+1);
 eq(Number((await db.query('SELECT last_value FROM target_private.hundred_test_rng')).rows[0].last_value),1599,'Only1600 binary draws are sampled for thirty simultaneous UUID replays');
 eq(await quota(a),100);eq(await count('casino_batches',a),2);eq(await count('casino_batch_rounds',a),120);
 eq(new Set(result.batch.rounds.map(r=>r.requestId)).size,100);
 for(let i=0;i<100;i++){eq(result.batch.rounds[i].requestId,games.childId(input.requestId,i+1));eq(result.batch.rounds[i].createdAt,result.batch.createdAt);}
 const beforeQuota=await quota(a),beforeEntropy=Number((await db.query('SELECT last_value FROM target_private.hundred_test_rng')).rows[0].last_value);
 eq((await rpc('batch',batch(a,{count:21}))).error.code,'RATE_LIMITED');eq(await quota(a),beforeQuota);eq(Number((await db.query('SELECT last_value FROM target_private.hundred_test_rng')).rows[0].last_value),beforeEntropy);
 const tail=await rpc('batch',batch(a,{count:20}));eq(tail.batch.count,20);eq(await quota(a),120);
 eq((await rpc('batch',input)).batch,result.batch,'Committed hundred-ball replay bypasses an exhausted quota');eq(await quota(a),120);
 eq((await rpc('batch',{...input,count:99})).error.code,'REQUEST_ID_CONFLICT');
 for(const bad of [0,101,'100',null])eq((await rpc('batch',batch(a,{count:bad}))).error.code,'INVALID_REQUEST');
 eq((await rpc('batch',batch(a,{requestId:games.childId(input.requestId,100),count:1}))).error.code,'REQUEST_ID_CONFLICT');
 await forceBin(0);const huge=await rpc('batch',batch(giant,{stake:100000}));eq(huge.batch.totalStake,10000000);eq(huge.batch.totalPayout,10000000000);eq(huge.batch.net,9990000000);eq(huge.wallet.totalIncome,10000000000);eq(huge.wallet.walletRevision,1);
 const bytes=Buffer.byteLength(JSON.stringify(huge));eq(bytes>16384&&bytes<65536,true,'Maximum100-ball reply needs the widened batch-only transport budget');
 await db.query("CREATE OR REPLACE FUNCTION target_private.secure_random_int(p_bound integer) RETURNS integer LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$ BEGIN RAISE EXCEPTION 'Entropy must not run'; END $$");
 eq((await rpc('batch',batch(poor,{stake:100000}))).error.code,'INSUFFICIENT_BALANCE');eq(await quota(poor),0);
 await db.query('INSERT INTO target_private.profiles(member_id,name,total_points,calculus_points,casino_net) VALUES($1,$2,9990010000010,10000000000000,-9989999990)',[near.memberId,near.name]);
 eq((await rpc('batch',batch(near,{stake:100000}))).error.code,'GAME_LIMIT');eq(await quota(near),0);
 const logical=(await db.query('SELECT logical_bytes FROM target_private.system_state')).rows[0].logical_bytes;await db.query('UPDATE target_private.system_state SET logical_bytes=104857600');
 eq((await rpc('batch',batch(storage))).error.code,'CAPACITY_LIMIT');eq(await quota(storage),0);await db.query('UPDATE target_private.system_state SET logical_bytes=$1',[logical]);
 const failBefore=await snap(fail),failCount=await count('casino_rounds',fail),parentsBefore=await count('casino_batches',fail);await forceBin(8,800);
 await assert.rejects(rpc('batch',batch(fail)),error=>/Injected hundred-ball/.test(error.message));checks++;
 eq(await snap(fail),failBefore);eq(await count('casino_rounds',fail),failCount);eq(await count('casino_batches',fail),parentsBefore);eq(await count('casino_batch_rounds',fail),0);eq(await quota(fail),0);
 const acl=(await db.query("SELECT has_table_privilege('anon','target_private.casino_batches','SELECT') parent,has_table_privilege('authenticated','target_private.casino_batch_rounds','INSERT') child,has_function_privilege('anon','target_private.batch_child_id(uuid,integer)','EXECUTE') id,has_function_privilege('anon','target_private.consume_game_balls(uuid,integer)','EXECUTE') quota")).rows[0];eq(acl,{parent:false,child:false,id:false,quota:false});
 await assert.rejects(db.query('UPDATE target_private.casino_batches SET net=net WHERE member_id=$1',[giant.memberId]),e=>e.code==='42501');checks++;
 console.log(JSON.stringify({hundredBallDatabase:'passed',checks,maximumReplyBytes:bytes,independentDirections:1600,concurrentCopies:30,maxPayout:10000000000,sharedBallLimit:120,hostedWrites:false}));
}finally{await db.end();}})().catch(error=>{console.error('Hundred-ball database verification failed: '+error.name+' '+error.message.replace(/\s+/g,' ').slice(0,250));process.exitCode=1;});
