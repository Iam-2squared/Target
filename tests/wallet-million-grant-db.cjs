'use strict';
// Exact operator-SQL regression. Synthetic users and a disposable loopback DB only.
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs/promises'),path=require('node:path');
const {Client}=require('pg');
const root=path.resolve(__dirname,'..'),uuid=()=>crypto.randomUUID();
const dbName=`target_million_grant_${process.pid}_${crypto.randomBytes(4).toString('hex')}_test`;
const secret=crypto.randomBytes(32).toString('base64url'),amount=1000000,max=10000000000000,capacity=104857600;
let admin,db,created=false,checks=0,buildGrantSql;
const eq=(actual,expected,label)=>{checks++;assert.deepEqual(actual,expected,label);};
const ok=(value,label)=>{checks++;assert.ok(value,label);};
const player=name=>({memberId:uuid(),name});
const a=player('台帳の名前A'),b=player('非対象B'),zero=player('既存ゼロ'),adminMember=player('管理者'),protectedMember=player('てつや');
const grant=(targets,extra={})=>({operationId:'income_adjust_qa_'+crypto.randomBytes(8).toString('hex'),reason:'Local authorized one-off million grant QA',amount,protectedId:protectedMember.memberId,targets,expectedCount:targets.length,...extra});
async function rpc(client,fn,action,input){return(await client.query(`SELECT public.${fn}($1,$2,$3::jsonb) AS value`,[secret,action,JSON.stringify(input)])).rows[0].value;}
async function calc(client,action,input){return rpc(client,'target_calculus_rpc',action,input);}
async function soccer(p,action,body={}){return rpc(db,'two_player_rpc',action,{...p,...body,...(!['state','wallet','list','expire'].includes(action)?{requestId:uuid()}: {})});}
async function profile(id,client=db){return(await client.query('SELECT to_jsonb(p) AS value FROM target_private.profiles p WHERE member_id=$1',[id])).rows[0]?.value;}
async function projection(){const r=await db.query("SELECT count(*)::int AS drift FROM target_private.profiles p JOIN target_private.wallet_finance_projection(NULL) l USING(member_id) WHERE (p.total_points,p.spent_points,p.calculus_points,p.birthday_points,p.casino_net,p.calculus_forgiven_points) IS DISTINCT FROM (l.total_points,l.spent_points,l.calculus_points,l.birthday_points,l.casino_net,l.calculus_forgiven_points)");eq(r.rows[0].drift,0,'all wallet components reconcile with permanent sources');}
async function tables(excluded=[]){const names=(await db.query("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='target_private' AND c.relkind='r' ORDER BY c.relname")).rows.map(r=>r.relname).filter(n=>!excluded.includes(n));const result={};for(const name of names){assert(/^[a-z0-9_]+$/.test(name));result[name]=(await db.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') AS value FROM target_private.${name} t`)).rows[0].value;}return result;}
const histories=()=>tables(['profiles','system_state','wallet_restoration_events','wallet_restorations']);
async function execute(snapshot,client=db){const sql=buildGrantSql(snapshot);ok(typeof sql==='string'&&sql.length>100,'executes exact exported SQL');try{const result=await client.query(sql);const results=Array.isArray(result)?result:[result];const receipts=results.flatMap(r=>r.rows||[]).flatMap(r=>Object.values(r)).filter(v=>v&&typeof v==='object'&&v.operationId===snapshot.operationId);ok(receipts.length>0,'operator SQL exposes its operation receipt');return receipts[receipts.length-1];}catch(error){await client.query('ROLLBACK');throw error;}}
function receipt(result,snapshot,replayed,createdProfiles){eq(result.operationId,snapshot.operationId);eq(result.members,snapshot.expectedCount);eq(result.amountPerMember,amount);eq(result.totalGranted,amount*snapshot.expectedCount);eq(result.replayed,replayed);eq(result.createdProfiles,createdProfiles);eq(result.protectedPreserved,true);eq(result.otherProfilesPreserved,true);eq(result.historyPreserved,true);eq(result.projectionMismatches,0);ok(/^[a-f0-9]{64}$/.test(result.rosterSha256),'frozen roster has an audit hash');}
async function rejectAtomic(snapshot,label,pattern){buildGrantSql(snapshot);const before=await tables();await assert.rejects(execute(snapshot),error=>{if(pattern)assert.match(error.message,pattern);return true;},label);checks++;eq(await tables(),before,label+' rolls back every table, wallet and logical reservation');await projection();}
async function seedCalc(p,userId,totalPoints){const r=await calc(db,'link',{...p,userId,totalPoints,known:true,deleted:false});eq(r.linked,true,'local source account linked');return r;}
async function adjust(p,totalIncome){const op='income_adjust_fixture_'+crypto.randomBytes(8).toString('hex');return(await db.query('SELECT target_private.adjust_wallet_income($1,$2::jsonb) AS value',[op,JSON.stringify({version:1,reason:'Local boundary fixture only',targets:[{memberId:p.memberId,expectedName:(await profile(p.memberId)).name,totalIncome}]})])).rows[0].value;}
async function main(){
 eq(process.env.NODE_ENV,'test','NODE_ENV=test is mandatory');
 const url=new URL(process.env.DATABASE_URL||'');ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname)&&!url.search&&!url.hash,'only a direct loopback database is allowed');
 ({buildGrantSql}=require('../scripts/grant-wallet-income.cjs'));eq(typeof buildGrantSql,'function','pure SQL builder is exported');
 const adminUrl=new URL(url);adminUrl.pathname='/postgres';admin=new Client({connectionString:adminUrl.href});await admin.connect();await admin.query(`CREATE DATABASE "${dbName}"`);created=true;
 url.pathname='/'+dbName;db=new Client({connectionString:url.href});await db.connect();
 await db.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF; END $$");
 const dir=path.join(root,'supabase/migrations');for(const file of(await fs.readdir(dir)).filter(f=>/^\d+_.*\.sql$/.test(f)).sort())await db.query(await fs.readFile(path.join(dir,file),'utf8'));
 const financeHash=(await db.query("SELECT md5(prosrc) AS hash FROM pg_proc WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure")).rows[0].hash;eq(financeHash,'8e69577732c1f54b2dae637b87aa3fd6','production financial projection is the reviewed version');
 for(const table of['server_credentials','two_player_credentials'])await db.query(`INSERT INTO target_private.${table}(singleton,key_hash) VALUES(true,encode(sha256(convert_to($1,'UTF8')),'hex'))`,[secret]);
 await seedCalc(a,1,200);await seedCalc(b,2,200);await seedCalc(protectedMember,31,100);
 await db.query('INSERT INTO target_private.profiles(member_id,name) VALUES($1,$2)',[zero.memberId,zero.name]);await db.query('UPDATE target_private.system_state SET logical_bytes=logical_bytes+512 WHERE singleton');
 const draw=await rpc(db,'target_shop_rpc','draw',{...a,requestId:uuid(),expectedPrice:100000,expectedCatalogVersion:3,itemType:'frame'});ok(!draw.error,'real inventory/spending receipt fixture succeeds');
 let match=await soccer(a,'create',{stake:100});ok(match.match,'funded soccer fixture created');const matchId=match.match.id;await soccer(b,'join',{code:match.match.code});await soccer(a,'ready',{matchId,ready:true});match=await soccer(b,'ready',{matchId,ready:true});eq(match.match.status,'playing','grant fixture has active escrow');
 await projection();
 const snapshot=grant([{memberId:a.memberId,name:'KGS側の別の名前'},zero,adminMember]);
 const originals=new Map();for(const p of[a,b,zero,protectedMember])originals.set(p.memberId,await profile(p.memberId));
 const oldHistories=await histories(),logicalBefore=Number((await db.query('SELECT logical_bytes FROM target_private.system_state WHERE singleton')).rows[0].logical_bytes);
 receipt(await execute(snapshot),snapshot,false,1);
 for(const p of[a,zero]){const before=originals.get(p.memberId),after=await profile(p.memberId);eq(after.total_points,before.total_points+amount,'gross income increases by exactly one million');eq(after.total_points-after.spent_points,before.total_points-before.spent_points+amount,'available balance increases by exactly one million');eq(after.casino_net,before.casino_net+amount,'explicit non-study correction component reconciles');eq(after.wallet_revision,before.wallet_revision+1,'one financial revision per eligible existing member');for(const key of Object.keys(before).filter(k=>!['total_points','casino_net','wallet_revision','updated_at'].includes(k)))eq(after[key],before[key],`existing ${key} is preserved`);}
 const newborn=await profile(adminMember.memberId);eq(newborn.name,'管理者','missing admin profile is initialized from the frozen label');eq(newborn.total_points,amount);eq(newborn.spent_points,0);eq(newborn.casino_net,amount);for(const key of['correct_count','answered_count','calculus_points','birthday_points','calculus_forgiven_points'])eq(newborn[key],0,'new member starts with zero source/counter '+key);
 for(const p of[b,protectedMember])eq(await profile(p.memberId),originals.get(p.memberId),'protected/nontarget profile is byte-for-byte unchanged');
 eq(await histories(),oldHistories,'source highwaters, items, quizzes, birthday/game history and funded matches are unchanged');
 eq(Number((await db.query('SELECT logical_bytes FROM target_private.system_state WHERE singleton')).rows[0].logical_bytes)-logicalBefore,512+1024+3*4096,'one missing profile and immutable audit rows are fully charged');
 const audit=(await db.query('SELECT component_deltas,spent_refund FROM target_private.wallet_restorations WHERE reset_id=$1 ORDER BY member_id',[snapshot.operationId])).rows;eq(audit.length,3);for(const r of audit){eq(r.component_deltas.totalPoints,amount);eq(r.component_deltas.casinoNet,amount);eq(r.component_deltas.incomeCorrection.kind,'authorized_income_adjustment_v1');eq(r.spent_refund,'0');}
 const event=(await db.query('SELECT cutoff_at=prepared_at AS current_time FROM target_private.wallet_restoration_events WHERE reset_id=$1',[snapshot.operationId])).rows[0];eq(event.current_time,true,'current correction never fabricates historical source timing');await projection();
 // Real later source earnings, an inventory purchase and a rename survive retries.
 eq((await calc(db,'sync',{totals:[{userId:1,totalPoints:201,known:true,deleted:false}]})).synced,1,'later genuine calculus earnings succeed');
 const {generateQuestions}=require('../server/questions.cjs');
 const questions=generateQuestions({book:'target1900',direction:'english',from:1,to:1,count:10,requestId:uuid()});
 const quiz=await rpc(db,'target_rpc','start',{...a,book:'target1900',direction:'english',from:1,to:1,requestId:uuid(),questions});ok(quiz.quizId,'later genuine study session starts');
 const answer=await rpc(db,'target_rpc','answer',{...a,quizId:quiz.quizId,questionId:questions[0].id,choiceId:questions[0].correctChoiceId,requestId:uuid()});eq(answer.correct,true,'later genuine study answer succeeds');ok(answer.awardPoints>0,'later study records its own source award');
 ok(!(await rpc(db,'target_shop_rpc','draw',{...a,requestId:uuid(),expectedPrice:100000,expectedCatalogVersion:3,itemType:'sticker'})).error,'later item purchase succeeds');
 await db.query('UPDATE target_private.profiles SET name=$2 WHERE member_id=$1',[a.memberId,'後から変更した名前']);
 const afterLater=await tables();receipt(await execute(snapshot),snapshot,true,0);eq(await tables(),afterLater,'replay neither recredits nor resets later income, spending, name or items');
 await rejectAtomic({...snapshot,reason:'Different authorization'},'same ID with changed reason');
 await rejectAtomic({...snapshot,targets:[zero,adminMember,b]},'same ID with changed frozen recipient set');
 await rejectAtomic({...snapshot,targets:snapshot.targets.map((p,i)=>i===0?{...p,name:'変更されたスナップショット'}:p)},'same ID with changed frozen roster metadata');
 assert.throws(()=>buildGrantSql({...snapshot,amount:2000000}));checks++;
 assert.throws(()=>buildGrantSql(grant([protectedMember])));checks++;
 assert.throws(()=>buildGrantSql(grant([zero,zero])));checks++;
 assert.throws(()=>buildGrantSql({...grant([zero]),expectedCount:2}));checks++;
 // Additive totals must be read after obtaining the shared income lock.
 const locker=new Client({connectionString:url.href}),worker=new Client({connectionString:url.href});await locker.connect();await worker.connect();let pending;
 try{await locker.query('BEGIN');await locker.query('SELECT pg_advisory_xact_lock(991101)');const workerPid=(await worker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;const concurrent=grant([zero]);pending=execute(concurrent,worker);pending.catch(()=>{});let blocked=false;for(let i=0;i<100;i++){const state=(await locker.query('SELECT wait_event FROM pg_stat_activity WHERE pid=$1',[workerPid])).rows[0];if(state?.wait_event==='advisory'){blocked=true;break;}await new Promise(r=>setTimeout(r,10));}ok(blocked,'operator waits for shared wallet serialization lock');const before=await profile(zero.memberId,locker);await locker.query('SELECT target_private.adjust_wallet_income($1,$2::jsonb)',['income_adjust_concurrent_'+crypto.randomBytes(8).toString('hex'),JSON.stringify({version:1,reason:'Concurrent locally authorized income',targets:[{memberId:zero.memberId,expectedName:before.name,totalIncome:before.total_points+10000}]})]);await locker.query('COMMIT');eq((await pending).replayed,false);eq((await profile(zero.memberId)).total_points,before.total_points+10000+amount,'grant adds to the value committed before lock acquisition');}finally{await locker.query('ROLLBACK');if(pending)await pending.catch(()=>{});await locker.end();await worker.end();}
 await projection();
 // Capacity rejection after profile preparation must leave no empty account or receipt.
 const logical=Number((await db.query('SELECT logical_bytes FROM target_private.system_state WHERE singleton')).rows[0].logical_bytes);
 await db.query('UPDATE target_private.system_state SET logical_bytes=$1 WHERE singleton',[capacity-(512+1024+4096)+1]);await rejectAtomic(grant([player('容量テスト')]),'audit capacity failure');await db.query('UPDATE target_private.system_state SET logical_bytes=$1 WHERE singleton',[logical]);
 const currentCount=(await db.query('SELECT count(*)::int AS n FROM target_private.profiles')).rows[0].n,dummies=Array.from({length:500-currentCount},uuid);
 await db.query("INSERT INTO target_private.profiles(member_id,name) SELECT id,'上限fixture' FROM unnest($1::uuid[]) id",[dummies]);await rejectAtomic(grant([player('501人目')]),'profile count cap failure');await db.query('DELETE FROM target_private.profiles WHERE member_id=ANY($1::uuid[])',[dummies]);
 // Pending soccer payouts must keep their reserved headroom even for a grant.
 await adjust(a,max-amount-100);await rejectAtomic(grant([player('巻き戻る新規'),{memberId:a.memberId,name:'KGS snapshot label'}]),'active escrow payout headroom failure',/headroom/);
 await adjust(zero,max-500000);await rejectAtomic(grant([player('上限時新規'),zero]),'money overflow failure');
 eq((await db.query("SELECT md5(prosrc) AS hash FROM pg_proc WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure")).rows[0].hash,financeHash,'no accounting implementation is changed');await projection();
 console.log(`PASS wallet-million-grant-db: ${checks} assertions; exact operator SQL, synthetic local users only`);
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1;}).finally(async()=>{if(db){try{await db.query('ROLLBACK');}catch{}await db.end();}if(admin){if(created)await admin.query(`DROP DATABASE "${dbName}"`);await admin.end();}});
