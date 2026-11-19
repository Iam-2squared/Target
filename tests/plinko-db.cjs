'use strict';
// Plinko upgrade/replay/settlement regressions in isolated local PostgreSQL.
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs/promises'),path=require('node:path');
const {Client,Pool}=require('pg'),{generateQuestions}=require('../server/questions.cjs');
const source=new URL(process.env.DATABASE_URL||'');assert.equal(process.env.NODE_ENV,'test');assert(['localhost','127.0.0.1','[::1]'].includes(source.hostname));source.pathname='/target_plinko_test';
const db=new Pool({connectionString:source.href,max:10}),secret=crypto.randomBytes(32).toString('base64url'),uuid=()=>crypto.randomUUID(),member={memberId:crypto.randomUUID(),name:'プリンク検証'};
const run=(name,action,input)=>db.query('SELECT public.'+name+'($1,$2,$3::jsonb) AS v',[secret,action,JSON.stringify(input)]).then(r=>r.rows[0].v),games=(action,input)=>run('target_games_rpc',action,input);
const play=(extra={})=>({...member,requestId:uuid(),game:'plinko',stake:100,choice:null,rulesVersion:3,...extra}),legacy=(version)=>play({game:'coin',choice:0,rulesVersion:version});
let checks=0;const eq=(a,b,message)=>{checks++;assert.deepEqual(a,b,message);};
(async()=>{try{
 const adminURL=new URL(source.href);adminURL.pathname='/postgres';const admin=new Client({connectionString:adminURL.href});await admin.connect();
 try{await admin.query('DROP DATABASE IF EXISTS target_plinko_test WITH (FORCE)');await admin.query('CREATE DATABASE target_plinko_test');}finally{await admin.end();}
 const dir=path.resolve(__dirname,'../supabase/migrations'),files=(await fs.readdir(dir)).filter(n=>/^\d+_.*\.sql$/.test(n)).sort(),v2=files.find(n=>n.endsWith('_target_g_games_rules_two.sql')),v3=files.find(n=>n.endsWith('_target_plinko_rules_three.sql'));assert(v2&&v3);
 for(const file of files.filter(n=>n<v2))await db.query(await fs.readFile(path.join(dir,file),'utf8'));
 await db.query("INSERT INTO target_private.server_credentials(singleton,key_hash) VALUES(true,encode(sha256(convert_to($1,'UTF8')),'hex'))",[secret]);
 await db.query('INSERT INTO target_private.profiles(member_id,name,total_points,correct_count,answered_count) VALUES($1,$2,1000000,10,10)',[member.memberId,member.name]);
 const rngOriginal=(await db.query("SELECT pg_get_functiondef('target_private.secure_random_int(integer)'::regprocedure) AS source")).rows[0].source;
 await db.query("CREATE OR REPLACE FUNCTION target_private.secure_random_int(p_bound integer) RETURNS integer LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS 'SELECT 0'");
 const input1=legacy(1),round1=await games('play',input1);eq(round1.round.payout,200);await db.query(await fs.readFile(path.join(dir,v2),'utf8'));
 const input2=legacy(2),round2=await games('play',input2);eq(round2.round.payout,150);
 const receipts=async()=>(await db.query('SELECT jsonb_agg(to_jsonb(r) ORDER BY member_id,request_id) AS rows FROM target_private.casino_rounds r')).rows[0].rows;
 const financials=async()=>(await db.query('SELECT member_id,total_points,casino_net,spent_points,wallet_revision FROM target_private.profiles ORDER BY member_id')).rows;
 const rowsBefore=await receipts(),moneyBefore=await financials(),hashes=async()=>(await db.query("SELECT proname,md5(pg_get_functiondef(oid)) AS hash FROM pg_proc WHERE oid IN ('public.target_rpc(text,text,jsonb)'::regprocedure,'public.target_shop_rpc(text,text,jsonb)'::regprocedure,'public.target_calculus_rpc(text,text,jsonb)'::regprocedure,'public.target_birthday_rpc(text,text,jsonb)'::regprocedure,'target_private.game_multiplier(text,integer,jsonb)'::regprocedure,'target_private.wallet_snapshot(uuid)'::regprocedure) ORDER BY proname")).rows;
 const unchanged=await hashes(),blocked=await db.connect(),waiter=await db.connect();let oldFailure;
 try{
  await blocked.query('BEGIN');await blocked.query('SELECT pg_advisory_xact_lock(991101)');const pid=(await waiter.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  const queued=waiter.query('SELECT public.target_games_rpc($1,$2,$3::jsonb) AS v',[secret,'play',JSON.stringify(legacy(2))]).then(()=>null,error=>error);
  let waiting=false;for(let n=0;n<100;n++){if((await blocked.query('SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted) AS waiting',[pid])).rows[0].waiting){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}eq(waiting,true);
  await blocked.query(await fs.readFile(path.join(dir,v3),'utf8'));oldFailure=await queued;
 }finally{await blocked.query('ROLLBACK');blocked.release();waiter.release();}
 eq(oldFailure?.code,'42501','Queued executing v2 writer cannot insert after Plinko activation');eq(await receipts(),rowsBefore);eq(await financials(),moneyBefore);eq(await hashes(),unchanged);
 for(const [input,old]of [[input1,round1],[input2,round2]]){const replay=await games('play',input);eq(replay.rulesVersion,3);eq(replay.round,old.round,'Historical payout and bindings are immutable');eq((await games('play',legacy(input.rulesVersion))).error.code,'RULES_CHANGED');}
 const first=await games('play',play());eq(first.round.outcome,Array(20).fill(0));eq(first.round.multiplier,2);eq(first.round.payout,200);eq(first.round.net,100);
 await db.query('CREATE SEQUENCE target_private.plinko_test_rolls MINVALUE 0 START 0');
 async function forceBin(bin){await db.query('ALTER SEQUENCE target_private.plinko_test_rolls RESTART WITH 0');await db.query("CREATE OR REPLACE FUNCTION target_private.secure_random_int(p_bound integer) RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$ DECLARE n bigint; BEGIN IF p_bound<>2 THEN RAISE EXCEPTION 'Plinko must use binary RNG'; END IF; n:=nextval('target_private.plinko_test_rolls');RETURN CASE WHEN n%20<"+bin+" THEN 1 ELSE 0 END;END $$");}
 await forceBin(9);const odd=await games('play',play());eq(odd.round.outcome.filter(Boolean).length,9);eq(odd.round.multiplier,0.2);eq(odd.round.payout,20);eq(odd.round.net,-80);eq(odd.wallet.totalIncome%100,70);eq(Number((await db.query('SELECT last_value FROM target_private.plinko_test_rolls')).rows[0].last_value),19,'Exactly20 independent binary decisions are consumed');
 await forceBin(5);const refund=await games('play',play());eq(refund.round.payout,100);eq(refund.round.net,0);eq(refund.wallet.walletRevision,odd.wallet.walletRevision+1);
 await forceBin(10);const loss=await games('play',play());eq(loss.round.multiplier,0);eq(loss.round.payout,0);eq(loss.round.net,-100);eq(loss.wallet.spent,0);
 for(let bin=0;bin<=20;bin++){const bits=Array.from({length:20},(_,i)=>i<bin?1:0),value=(await db.query("SELECT target_private.game_multiplier_for_rules(3,'plinko',NULL,$1::jsonb)::float8 AS m",[JSON.stringify(bits)])).rows[0].m;eq(value,Math.abs(bin-10)/5);}
 const request=play();await forceBin(0);const concurrent=await Promise.all(Array.from({length:40},()=>games('play',request)));eq(new Set(concurrent.map(value=>JSON.stringify(value))).size,1);eq((await db.query('SELECT count(*)::integer AS n FROM target_private.casino_rounds WHERE member_id=$1 AND request_id=$2',[member.memberId,request.requestId])).rows[0].n,1);
 eq((await games('play',{...request,stake:200})).error.code,'REQUEST_ID_CONFLICT');const state=await games('state',member);eq(state.rulesVersion,3);eq(new Set(state.rounds.map(row=>row.rulesVersion)),new Set([1,2,3]));
 await db.query(rngOriginal);
 const purchase=await run('target_shop_rpc','draw',{...member,requestId:uuid(),expectedPrice:100000,expectedCatalogVersion:3,itemType:'frame'});eq(purchase.spent,100000);eq(purchase.totalIncome%100,70);eq(purchase.balance%100,70);
 const link=await run('target_calculus_rpc','link',{...member,userId:1,totalPoints:9,known:true,deleted:false});eq(link.totalIncome%100,70);eq(link.calculusIncome,90000);
 eq((await run('target_birthday_rpc','grant',{gifts:[{...member,birthdayDate:'2026-01-01'}]})).granted,1);
 const questions=generateQuestions({book:'target1900',direction:'english',count:10,from:1,to:10,requestId:uuid()}),quiz=await run('target_rpc','start',{...member,requestId:uuid(),book:'target1900',direction:'english',from:1,to:10,questions});
 const answer=await run('target_rpc','answer',{...member,quizId:quiz.quizId,questionId:questions[0].id,choiceId:questions[0].correctChoiceId,requestId:uuid()});eq(answer.correct,true);eq(answer.totalPoints%100,70);
 await assert.rejects(db.query('UPDATE target_private.profiles SET total_points=total_points+10 WHERE member_id=$1',[member.memberId]),error=>error.code==='23514');checks++;
 await assert.rejects(db.query('UPDATE target_private.profiles SET spent_points=spent_points+10 WHERE member_id=$1',[member.memberId]),error=>error.code==='23514');checks++;
 const near={memberId:uuid(),name:'最大二倍'};await db.query('INSERT INTO target_private.profiles(member_id,name,total_points,calculus_points,casino_net) VALUES($1,$2,9999999999900,10000000000000,-100)',[near.memberId,near.name]);await forceBin(0);const max=await games('play',play({...near}));eq(max.wallet.totalIncome,10000000000000);eq(max.round.multiplier,2);
 await db.query("CREATE OR REPLACE FUNCTION target_private.secure_random_int(p_bound integer) RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$ BEGIN RAISE EXCEPTION 'No entropy expected'; END $$");
 eq((await games('play',play({...near}))).error.code,'GAME_LIMIT');for(const version of [1,2]){eq((await games('play',legacy(version))).error.code,'RULES_CHANGED');eq((await games('play',version===1?input1:input2)).round,(version===1?round1:round2).round);}
 await db.query(rngOriginal);
 console.log(JSON.stringify({plinkoDatabase:'passed',checks,rows:20,bins:21,maxMultiplier:2,queuedLegacyWriterRejected:true,historicalV1V2ReceiptsPreserved:true,hostedWrites:false}));
}finally{await db.end();}})().catch(error=>{console.error('Plinko database verification failed: '+error.name+' '+error.message.replace(/\s+/g,' ').slice(0,200));process.exitCode=1;});
