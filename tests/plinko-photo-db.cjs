'use strict';
// Photo-payout upgrade and high-limit financial checks. Local PostgreSQL only.
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs/promises'),path=require('node:path');
const {Client,Pool}=require('pg');
const source=new URL(process.env.DATABASE_URL||'');assert.equal(process.env.NODE_ENV,'test');assert(['localhost','127.0.0.1','[::1]'].includes(source.hostname));source.pathname='/target_plinko_photo_test';
const db=new Pool({connectionString:source.href,max:10}),secret=crypto.randomBytes(32).toString('base64url'),uuid=()=>crypto.randomUUID(),member={memberId:crypto.randomUUID(),name:'写真配当の検証'};
const run=(name,action,input)=>db.query('SELECT public.'+name+'($1,$2,$3::jsonb) AS v',[secret,action,JSON.stringify(input)]).then(r=>r.rows[0].v),games=(action,input)=>run('target_games_rpc',action,input);
const play=(extra={})=>({...member,requestId:uuid(),game:'plinko',stake:100,choice:null,rulesVersion:4,...extra}),tenths=[10000,1300,260,90,40,20,2,2,2,2,2,20,40,90,260,1300,10000];
let checks=0;const eq=(a,b,message)=>{checks++;assert.deepEqual(a,b,message);};
(async()=>{try{
 const adminURL=new URL(source.href);adminURL.pathname='/postgres';const admin=new Client({connectionString:adminURL.href});await admin.connect();
 try{await admin.query('DROP DATABASE IF EXISTS target_plinko_photo_test WITH (FORCE)');await admin.query('CREATE DATABASE target_plinko_photo_test');}finally{await admin.end();}
 const dir=path.resolve(__dirname,'../supabase/migrations'),files=(await fs.readdir(dir)).filter(n=>/^\d+_.*\.sql$/.test(n)).sort(),latest=files.find(n=>n.endsWith('_target_plinko_photo_rules_four.sql'));assert(latest);
 for(const file of files.filter(n=>n<latest))await db.query(await fs.readFile(path.join(dir,file),'utf8'));
 await db.query("INSERT INTO target_private.server_credentials(singleton,key_hash) VALUES(true,encode(sha256(convert_to($1,'UTF8')),'hex'))",[secret]);
 await db.query('INSERT INTO target_private.profiles(member_id,name,total_points,correct_count,answered_count) VALUES($1,$2,1000000,10,10)',[member.memberId,member.name]);
 const originalRng=(await db.query("SELECT pg_get_functiondef('target_private.secure_random_int(integer)'::regprocedure) AS source")).rows[0].source;
 await db.query("CREATE OR REPLACE FUNCTION target_private.secure_random_int(p_bound integer) RETURNS integer LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS 'SELECT 0'");
 const oldInput=play({rulesVersion:3}),old=await games('play',oldInput);eq(old.round.outcome,Array(20).fill(0));eq(old.round.payout,200);
 const receipts=async()=>(await db.query('SELECT jsonb_agg(to_jsonb(r) ORDER BY member_id,request_id) AS rows FROM target_private.casino_rounds r')).rows[0].rows;
 const financials=async()=>(await db.query('SELECT member_id,total_points,casino_net,spent_points,wallet_revision FROM target_private.profiles ORDER BY member_id')).rows;
 const beforeRows=await receipts(),beforeMoney=await financials(),hashes=async()=>(await db.query("SELECT proname,md5(pg_get_functiondef(oid)) AS hash FROM pg_proc WHERE oid IN ('public.target_rpc(text,text,jsonb)'::regprocedure,'public.target_shop_rpc(text,text,jsonb)'::regprocedure,'public.target_calculus_rpc(text,text,jsonb)'::regprocedure,'public.target_birthday_rpc(text,text,jsonb)'::regprocedure,'target_private.game_multiplier(text,integer,jsonb)'::regprocedure,'target_private.wallet_snapshot(uuid)'::regprocedure) ORDER BY proname")).rows;
 const unchanged=await hashes(),blocked=await db.connect(),waiter=await db.connect();let oldFailure;
 try{
  await blocked.query('BEGIN');await blocked.query('SELECT pg_advisory_xact_lock(991101)');const pid=(await waiter.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  const queued=waiter.query('SELECT public.target_games_rpc($1,$2,$3::jsonb) AS v',[secret,'play',JSON.stringify(play({rulesVersion:3}))]).then(()=>null,error=>error);
  let waiting=false;for(let n=0;n<100;n++){if((await blocked.query('SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted) AS waiting',[pid])).rows[0].waiting){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}eq(waiting,true);
  await blocked.query(await fs.readFile(path.join(dir,latest),'utf8'));oldFailure=await queued;
 }finally{await blocked.query('ROLLBACK');blocked.release();waiter.release();}
 eq(oldFailure?.code,'42501','An old executing v3 body cannot insert after v4 activation');eq(await receipts(),beforeRows,'Numeric widening preserves historical canonical receipt values');eq(await financials(),beforeMoney);eq(await hashes(),unchanged);
 eq((await db.query("SELECT format_type(atttypid,atttypmod) AS type FROM pg_attribute WHERE attrelid='target_private.casino_rounds'::regclass AND attname='multiplier'")).rows[0].type,'numeric(6,1)');
 const replay=await games('play',oldInput);eq(replay.rulesVersion,4);eq(replay.round,old.round);eq((await games('play',play({rulesVersion:3}))).error.code,'RULES_CHANGED');
 const edge=await games('play',play({stake:100000}));eq(edge.round.outcome,Array(16).fill(0));eq(edge.round.multiplier,1000);eq(edge.round.payout,100000000);eq(edge.round.net,99900000);eq(edge.wallet.spent,0);
 await db.query('CREATE SEQUENCE target_private.photo_test_rolls MINVALUE 0 START 0');
 async function forceBin(bin){await db.query('ALTER SEQUENCE target_private.photo_test_rolls RESTART WITH 0');await db.query("CREATE OR REPLACE FUNCTION target_private.secure_random_int(p_bound integer) RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$ DECLARE n bigint;BEGIN IF p_bound<>2 THEN RAISE EXCEPTION 'Photo Plinko requires binary RNG';END IF;n:=nextval('target_private.photo_test_rolls');RETURN CASE WHEN n%16<"+bin+" THEN 1 ELSE 0 END;END $$");}
 await forceBin(8);const center=await games('play',play());eq(center.round.multiplier,0.2);eq(center.round.payout,20);eq(center.round.net,-80);eq(Number((await db.query('SELECT last_value FROM target_private.photo_test_rolls')).rows[0].last_value),15,'Exactly16 independent binary decisions are consumed');
 for(let bin=0;bin<=16;bin++){const bits=Array.from({length:16},(_,i)=>i<bin?1:0),multiplier=(await db.query("SELECT target_private.game_multiplier_for_rules(4,'plinko',NULL,$1::jsonb)::float8 AS m",[JSON.stringify(bits)])).rows[0].m;eq(multiplier,tenths[bin]/10);}
 eq((await games('state',member)).rulesVersion,4);eq(new Set((await games('state',member)).rounds.map(row=>row.rulesVersion)),new Set([3,4]));
 const request=play();await forceBin(5);const concurrent=await Promise.all(Array.from({length:40},()=>games('play',request)));eq(new Set(concurrent.map(value=>JSON.stringify(value))).size,1);eq((await db.query('SELECT count(*)::integer AS n FROM target_private.casino_rounds WHERE member_id=$1 AND request_id=$2',[member.memberId,request.requestId])).rows[0].n,1);
 const near={memberId:uuid(),name:'千倍の上限'};await db.query('INSERT INTO target_private.profiles(member_id,name,total_points,calculus_points,casino_net) VALUES($1,$2,9999999900100,10000000000000,-99900)',[near.memberId,near.name]);await forceBin(0);const max=await games('play',play({...near}));eq(max.wallet.totalIncome,10000000000000);eq(max.round.payout,100000);
 const low={memberId:uuid(),name:'八割損の下限'};await db.query('INSERT INTO target_private.profiles(member_id,name,total_points,calculus_points,casino_net,correct_count,answered_count) VALUES($1,$2,180,10000000000000,-9999999999920,1,1)',[low.memberId,low.name]);await forceBin(8);const minimum=await games('play',play({...low}));eq(minimum.round.net,-80);eq(minimum.wallet.gameNet,-10000000000000);eq(minimum.wallet.balance,100,'Minimum-return lower bound uses actual80% maximum loss');
 await db.query("CREATE OR REPLACE FUNCTION target_private.secure_random_int(p_bound integer) RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$ BEGIN RAISE EXCEPTION 'No entropy expected';END $$");
 eq((await games('play',play({...near}))).error.code,'GAME_LIMIT');for(const version of [1,2,3]){const fresh=version===3?play({rulesVersion:version}):play({game:'coin',choice:0,rulesVersion:version});eq((await games('play',fresh)).error.code,'RULES_CHANGED');}eq((await games('play',oldInput)).round,old.round);
 await db.query(originalRng);const purchased=await run('target_shop_rpc','draw',{...member,requestId:uuid(),expectedPrice:100000,expectedCatalogVersion:3,itemType:'frame'});eq(purchased.spent,100000);eq(purchased.totalIncome%100,20);eq(purchased.balance%100,20);
 const link=await run('target_calculus_rpc','link',{...member,userId:1,totalPoints:9,known:true,deleted:false});eq(link.totalIncome%100,20);eq(link.calculusIncome,90000);eq((await run('target_birthday_rpc','grant',{gifts:[{...member,birthdayDate:'2026-01-01'}]})).granted,1);
 const snapshot=await games('snapshot',{memberId:member.memberId});eq(snapshot.totalIncome%100,20);eq(snapshot.spent%100,0);
 console.log(JSON.stringify({photoPlinkoDatabase:'passed',checks,rows:16,bins:17,maxMultiplier:1000,maxPayout:100000000,queuedV3WriterRejected:true,historicalReceiptsPreserved:true,hostedWrites:false}));
}finally{await db.end();}})().catch(error=>{console.error('Photo Plinko database verification failed: '+error.name+' '+error.message.replace(/\s+/g,' ').slice(0,200));process.exitCode=1;});
