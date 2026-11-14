'use strict';
// Upgrade and fractional-multiplier accounting checks, local PostgreSQL only.
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs/promises'),path=require('node:path');
const {Client,Pool}=require('pg'),{generateQuestions}=require('../server/questions.cjs');
const source=new URL(process.env.DATABASE_URL||'');assert.equal(process.env.NODE_ENV,'test');assert(['localhost','127.0.0.1','[::1]'].includes(source.hostname));source.pathname='/target_g_rules_two_test';
const db=new Pool({connectionString:source.href,max:10}),secret=crypto.randomBytes(32).toString('base64url'),uuid=()=>crypto.randomUUID(),member={memberId:crypto.randomUUID(),name:'第二版の検証'};
const run=(name,action,input)=>db.query('SELECT public.'+name+'($1,$2,$3::jsonb) AS v',[secret,action,JSON.stringify(input)]).then(r=>r.rows[0].v);
const games=(action,input)=>run('target_games_rpc',action,input),play=(extra={})=>({...member,requestId:uuid(),game:'coin',stake:100,choice:0,rulesVersion:2,...extra});
let checks=0;const eq=(a,b,message)=>{checks++;assert.deepEqual(a,b,message);};
(async()=>{try{
 const adminURL=new URL(source.href);adminURL.pathname='/postgres';const admin=new Client({connectionString:adminURL.href});await admin.connect();
 try{await admin.query('DROP DATABASE IF EXISTS target_g_rules_two_test WITH (FORCE)');await admin.query('CREATE DATABASE target_g_rules_two_test');}finally{await admin.end();}
 const dir=path.resolve(__dirname,'../supabase/migrations'),files=(await fs.readdir(dir)).filter(n=>/^\d+_.*\.sql$/.test(n)).sort(),latest=files.find(n=>n.endsWith('_target_g_games_rules_two.sql'));assert(latest);
 for(const file of files.filter(n=>n<latest))await db.query(await fs.readFile(path.join(dir,file),'utf8'));
 await db.query("INSERT INTO target_private.server_credentials(singleton,key_hash) VALUES(true,encode(sha256(convert_to($1,'UTF8')),'hex'))",[secret]);
 await db.query('INSERT INTO target_private.profiles(member_id,name,total_points,correct_count,answered_count) VALUES($1,$2,1000000,10,10)',[member.memberId,member.name]);
 const originalRng=(await db.query("SELECT pg_get_functiondef('target_private.secure_random_int(integer)'::regprocedure) AS source")).rows[0].source;
 await db.query("CREATE OR REPLACE FUNCTION target_private.secure_random_int(p_bound integer) RETURNS integer LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS 'SELECT 0'");
 const oldInput=play({rulesVersion:1}),old=await games('play',oldInput);eq(old.round.payout,200);eq(old.round.net,100);
 const receipts=async()=>(await db.query('SELECT jsonb_agg(to_jsonb(r) ORDER BY member_id,request_id) AS rows FROM target_private.casino_rounds r')).rows[0].rows;
 const financials=async()=>(await db.query('SELECT member_id,total_points,casino_net,spent_points,wallet_revision FROM target_private.profiles ORDER BY member_id')).rows;
 const originals=await receipts(),before=await financials(),hashes=async()=>(await db.query("SELECT proname,md5(pg_get_functiondef(oid)) AS hash FROM pg_proc WHERE oid IN ('public.target_rpc(text,text,jsonb)'::regprocedure,'public.target_shop_rpc(text,text,jsonb)'::regprocedure,'public.target_calculus_rpc(text,text,jsonb)'::regprocedure,'public.target_birthday_rpc(text,text,jsonb)'::regprocedure,'target_private.game_multiplier(text,integer,jsonb)'::regprocedure,'target_private.wallet_snapshot(uuid)'::regprocedure) ORDER BY proname")).rows;
 const unchanged=await hashes(),blocked=await db.connect(),waiter=await db.connect(),queuedInput=play({rulesVersion:1});let oldFailure;
 try{
  await blocked.query('BEGIN');await blocked.query('SELECT pg_advisory_xact_lock(991101)');const pid=(await waiter.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  const queued=waiter.query('SELECT public.target_games_rpc($1,$2,$3::jsonb) AS v',[secret,'play',JSON.stringify(queuedInput)]).then(()=>null,error=>error);
  let waiting=false;for(let n=0;n<100;n++){if((await blocked.query('SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted) AS waiting',[pid])).rows[0].waiting){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}
  eq(waiting,true,'An actual executing v1 body waits across activation');
  await blocked.query(await fs.readFile(path.join(dir,latest),'utf8'));oldFailure=await queued;
 }finally{await blocked.query('ROLLBACK');blocked.release();waiter.release();}
 eq(oldFailure?.code,'42501','An old in-flight v1 body cannot insert after v2 activation');eq(await receipts(),originals,'Logical historical receipts, payouts and timestamps remain identical');eq(await financials(),before,'Upgrade and rejected old body change no income or spending');eq(await hashes(),unchanged,'Existing source/quiz/shop and original integer helper definitions stay unchanged');
 const replay=await games('play',oldInput);eq(replay.rulesVersion,2);eq(replay.round,old.round,'Uncertain historical v1 requests replay their original payout');eq((await games('play',play({rulesVersion:1}))).error.code,'RULES_CHANGED');
 const coin=await games('play',play());eq(coin.rulesVersion,2);eq(coin.round.multiplier,1.5);eq(coin.round.payout,150);eq(coin.round.net,50);eq(coin.wallet.totalIncome,1000150);eq(coin.wallet.gameNet,150);eq(coin.wallet.walletRevision,old.wallet.walletRevision+1);
 const dice=await games('play',play({game:'dice',choice:1}));eq(dice.round.multiplier,2);eq(dice.round.payout,200);eq(dice.round.net,100);
 const slots=await games('play',play({game:'slots',choice:null}));eq(slots.round.multiplier,3);eq(slots.round.payout,300);eq(slots.round.net,200);
 const state=await games('state',member);eq(state.rulesVersion,2);eq(new Set(state.rounds.map(r=>r.rulesVersion)),new Set([1,2]));
 const counts=(await db.query("SELECT target_private.game_multiplier_for_rules(2,'slots',NULL,jsonb_build_array(a,b,c))::float8 AS multiplier,count(*)::integer AS count FROM generate_series(0,5)a CROSS JOIN generate_series(0,5)b CROSS JOIN generate_series(0,5)c GROUP BY multiplier ORDER BY multiplier")).rows;eq(counts,[{multiplier:0,count:120},{multiplier:1,count:90},{multiplier:3,count:6}],'v2 returns108/216 stakes with unchanged outcome probabilities');
 const purchased=await run('target_shop_rpc','draw',{...member,requestId:uuid(),expectedPrice:100000,expectedCatalogVersion:3,itemType:'frame'});eq(purchased.totalIncome%100,50);eq(purchased.balance%100,50);eq(purchased.spent,100000,'Gacha spending retains100-grid while income can end in50');
 const linked=await run('target_calculus_rpc','link',{...member,userId:1,totalPoints:9,known:true,deleted:false});eq(linked.totalIncome%100,50);eq(linked.calculusIncome,90000);
 eq((await run('target_birthday_rpc','grant',{gifts:[{...member,birthdayDate:'2026-01-01'}]})).granted,1);eq((await games('snapshot',{memberId:member.memberId})).totalIncome%100,50);
 const questions=generateQuestions({book:'target1900',direction:'english',count:10,from:1,to:10,requestId:uuid()}),quiz=await run('target_rpc','start',{...member,requestId:uuid(),book:'target1900',direction:'english',from:1,to:10,questions});
 const answer=await run('target_rpc','answer',{...member,quizId:quiz.quizId,questionId:questions[0].id,choiceId:questions[0].correctChoiceId,requestId:uuid()});eq(answer.correct,true);eq(answer.totalPoints%100,50);eq(answer.awardPoints%100,0,'Quiz source reward units remain100');
 await assert.rejects(db.query('UPDATE target_private.profiles SET total_points=total_points+50 WHERE member_id=$1',[member.memberId]),error=>error.code==='23514');checks++;
 await assert.rejects(db.query('UPDATE target_private.profiles SET spent_points=spent_points+50 WHERE member_id=$1',[member.memberId]),error=>error.code==='23514');checks++;
 const near={memberId:uuid(),name:'新しい上限'};await db.query('INSERT INTO target_private.profiles(member_id,name,total_points,calculus_points,casino_net) VALUES($1,$2,9999999999950,10000000000000,-50)',[near.memberId,near.name]);
 const limitWin=await games('play',play({...near}));eq(limitWin.round.net,50);eq(limitWin.wallet.totalIncome,10000000000000,'Preflight uses new1.5x maximum rather than old2x');
 await db.query("CREATE OR REPLACE FUNCTION target_private.secure_random_int(p_bound integer) RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$ BEGIN RAISE EXCEPTION 'No entropy expected'; END $$");
 eq((await games('play',play({...near,choice:1}))).error.code,'GAME_LIMIT');eq((await games('play',oldInput)).round,old.round,'Historical replay bypasses entropy under new rules');
 eq((await games('play',play({rulesVersion:1}))).error.code,'RULES_CHANGED','Unseen v1 requests are rejected before consuming entropy');
 await db.query(originalRng);
 const acl=(await db.query("SELECT has_function_privilege('anon','target_private.game_multiplier_for_rules(integer,text,integer,jsonb)','EXECUTE') AS formula,has_function_privilege('authenticated','target_private.enforce_game_rules_protocol()','EXECUTE') AS protocol")).rows[0];eq(acl,{formula:false,protocol:false});
 console.log(JSON.stringify({gamesVersionTwoDatabase:'passed',checks,inFlightOldBodyRejected:true,historicalReceiptsPreserved:true,coinStake100Payout150:true,hostedWrites:false}));
}finally{await db.end();}})().catch(error=>{console.error('Games v2 database verification failed: '+error.name+' '+error.message.replace(/\s+/g,' ').slice(0,200));process.exitCode=1;});
