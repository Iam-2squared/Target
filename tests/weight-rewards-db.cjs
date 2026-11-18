'use strict';
// Disposable loopback Postgres only; no hosted calls or learner accounts.
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const fs=require('node:fs/promises'),path=require('node:path');
const {Client}=require('pg');
const root=path.resolve(__dirname,'..');
const migration='20261118145401_target_weight_workout_income.sql';
const database='target_weight_'+process.pid+'_'+crypto.randomBytes(4).toString('hex')+'_test';
const secret=crypto.randomBytes(40).toString('hex');
const actor={memberId:crypto.randomUUID(),name:'Weight Fixture'};
let admin,db,created=false,checks=0;
const eq=(a,b,label)=>{checks++;assert.deepEqual(a,b,label);};
const ok=(value,label)=>{checks++;assert(value,label);};
const rpc=async(action,input=actor,client=db,key=secret)=>(await client.query('SELECT public.target_weight_rpc($1,$2,$3::jsonb) AS value',[key,action,JSON.stringify(input)])).rows[0].value;
async function hashes(){
 const tables=(await db.query("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='target_private' AND c.relkind='r' ORDER BY c.relname")).rows;
 const rows={};for(const {relname}of tables)rows[relname]=(await db.query('SELECT md5(coalesce(string_agg(to_jsonb(t)::text,\'\' ORDER BY to_jsonb(t)::text),\'\')) AS hash FROM target_private.'+relname+' t')).rows[0].hash;
 return rows;
}
async function reconcile(){
 eq((await db.query('SELECT count(*)::integer n FROM target_private.profiles p JOIN target_private.wallet_finance_projection(NULL) f USING(member_id) WHERE (p.total_points,p.spent_points,p.casino_net) IS DISTINCT FROM(f.total_points,f.spent_points,f.casino_net)')).rows[0].n,0,'every fixture reconciles with the immutable-history finance projection');
}
async function main(){
 eq(process.env.NODE_ENV,'test');const url=new URL(process.env.DATABASE_URL||'');
 ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&!url.search&&!url.hash,'loopback-only disposable test database');
 const owner=new URL(url);owner.pathname='/postgres';admin=new Client({connectionString:owner.href});await admin.connect();
 await admin.query('CREATE DATABASE "'+database+'"');created=true;url.pathname='/'+database;db=new Client({connectionString:url.href});await db.connect();
 await db.query("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN;END IF;IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN;END IF;IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN;END IF;END $$");
 for(const file of(await fs.readdir(path.join(root,'supabase/migrations'))).filter(x=>/^\d+_.*\.sql$/.test(x)&&x!==migration).sort())await db.query(await fs.readFile(path.join(root,'supabase/migrations',file),'utf8'));
 await db.query("INSERT INTO target_private.server_credentials(singleton,key_hash) VALUES(true,encode(sha256(convert_to($1,'UTF8')),'hex'))",[secret]);
 await db.query('INSERT INTO target_private.profiles(member_id,name) VALUES($1,$2)',[actor.memberId,actor.name]);
 const before=await hashes(),oldProjection=(await db.query('SELECT * FROM target_private.wallet_finance_projection(NULL)')).rows;
 const functions=(await db.query("SELECT oid::regprocedure::text name,md5(prosrc) hash FROM pg_proc WHERE pronamespace IN('target_private'::regnamespace,'public'::regnamespace)")).rows;
 await db.query(await fs.readFile(path.join(root,'supabase/migrations',migration),'utf8'));
 const after=await hashes();delete after.weight_reward_receipts;eq(after,before,'migration rewrites no existing private row');
 eq((await db.query('SELECT * FROM target_private.wallet_finance_projection(NULL)')).rows,oldProjection,'empty Weight ledger leaves old finance projection identical');
 for(const f of functions)if(f.name!=='target_private.wallet_finance_projection(timestamp with time zone)')eq((await db.query('SELECT md5(prosrc) hash FROM pg_proc WHERE oid=$1::regprocedure',[f.name])).rows[0].hash,f.hash,'unrelated DB function unchanged: '+f.name);
 eq((await db.query('SELECT count(*)::integer n FROM target_private.weight_reward_receipts')).rows[0].n,0,'no retroactive payouts');
 const absent={memberId:crypto.randomUUID(),name:'No Profile'};
 eq(await rpc('status',absent),{weightIncome:0,totalIncome:0,balance:0});
 eq((await db.query('SELECT count(*)::integer n FROM target_private.profiles WHERE member_id=$1',[absent.memberId])).rows[0].n,0,'status does not allocate profiles');
 eq((await rpc('credit',{...actor,sessionId:'workout_12345678',reps:3},db,'wrong-secret')).error.code,'RPC_FORBIDDEN');
 for(const input of[{...actor,sessionId:'short',reps:3},{...actor,sessionId:'workout_12345678',reps:0},{...actor,sessionId:'workout_12345678',reps:5001},
   {...actor,sessionId:'workout_12345678',reps:1.5},{...actor,sessionId:'workout_12345678',reps:'3'},{...actor,sessionId:'workout_12345678',reps:3,amount:3000}])eq((await rpc('credit',input)).error.code,'INVALID_REQUEST');
 const input={...actor,sessionId:'workout_12345678',reps:3};
 const first=await rpc('credit',input);
 eq(first,{weightIncome:3000,totalIncome:3000,balance:3000,sessionId:input.sessionId,reps:3,creditedAmount:3000,replayed:false});
 const profile=(await db.query('SELECT correct_count,total_points,casino_net,wallet_revision FROM target_private.profiles WHERE member_id=$1',[actor.memberId])).rows[0];
 eq(profile,{correct_count:'0',total_points:'3000',casino_net:'3000',wallet_revision:'1'},'exercise does not fake study answers and advances wallet revision');
 eq((await db.query('SELECT raw_study_points FROM target_private.wallet_finance_projection(NULL) WHERE member_id=$1',[actor.memberId])).rows[0].raw_study_points,'0');
 eq((await db.query('SELECT target_private.wallet_finance_state(p) state FROM target_private.profiles p WHERE member_id=$1',[actor.memberId])).rows[0].state.rawStudyPoints,0);
 const accepted=await hashes();eq(await rpc('credit',input),{...first,replayed:true});eq(await hashes(),accepted,'replay changes no rows, timestamp, revision or quota');
 eq((await rpc('credit',{...input,reps:4})).error.code,'REQUEST_ID_CONFLICT');eq(await hashes(),accepted,'conflicting replay is read-only');
 await reconcile();
 const secondClient=new Client({connectionString:url.href});await secondClient.connect();
 try{
  const concurrent={...actor,sessionId:'concurrent_12345678',reps:2};
  const results=await Promise.all([rpc('credit',concurrent),rpc('credit',concurrent,secondClient)]);
  eq(results.filter(r=>r.replayed===false).length,1,'only one concurrent retry credits');
  eq(results.filter(r=>r.replayed===true).length,1);
 }finally{await secondClient.end();}
 eq(await rpc('status'),{weightIncome:5000,totalIncome:5000,balance:5000});
 await reconcile();
 // A session key is scoped to its verified member, never a shared browser.
 eq((await rpc('credit',{...absent,sessionId:input.sessionId,reps:1})).weightIncome,1000);
 eq((await rpc('status')).weightIncome,5000);
 // Changes to cached total/balance after an administrative operation cannot
 // turn an old receipt into a fresh credit. Restore the fixture after checking.
 await db.query('UPDATE target_private.profiles SET total_points=2000,casino_net=2000 WHERE member_id=$1',[actor.memberId]);
 eq(await rpc('status'),{weightIncome:5000,totalIncome:2000,balance:2000});
 const reduced=await hashes();eq((await rpc('credit',input)).replayed,true);eq(await hashes(),reduced,'replay never undoes an authorized financial reduction');
 await db.query('UPDATE target_private.profiles SET total_points=5000,casino_net=5000 WHERE member_id=$1',[actor.memberId]);
 await reconcile();
 const cutoff=(await db.query('SELECT clock_timestamp() now')).rows[0].now;
 await db.query('SELECT pg_sleep(0.01)');
 await rpc('credit',{...actor,sessionId:'cutoff_12345678',reps:1});
 eq((await db.query('SELECT total_points FROM target_private.wallet_finance_projection($1) WHERE member_id=$2',[cutoff,actor.memberId])).rows[0].total_points,'5000','timestamp projection excludes later Weight receipts');
 for(const role of['anon','authenticated','service_role']){
  ok(!(await db.query("SELECT has_table_privilege($1,'target_private.weight_reward_receipts','SELECT') yes",[role])).rows[0].yes,'private receipt table: '+role);
  for(const signature of['target_private.weight_income(uuid)','target_private.weight_status(uuid)','target_private.protect_weight_reward_receipt()'])ok(!(await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') yes",[role,signature])).rows[0].yes,'private helper: '+role+' '+signature);
 }
 for(const sql of['UPDATE target_private.weight_reward_receipts SET reps=reps','DELETE FROM target_private.weight_reward_receipts']){await assert.rejects(()=>db.query(sql),{code:'42501'});checks++;}
 const capacity=(await db.query('SELECT logical_bytes FROM target_private.system_state WHERE singleton')).rows[0].logical_bytes;
 await db.query('UPDATE target_private.system_state SET logical_bytes=104857600 WHERE singleton');
 const full=await hashes();eq((await rpc('credit',{...actor,sessionId:'fullcap_12345678',reps:1})).error.code,'CAPACITY_LIMIT');eq(await hashes(),full,'capacity rejection never creates a receipt or credit');
 await db.query('UPDATE target_private.system_state SET logical_bytes=$1 WHERE singleton',[capacity]);
 await db.query('UPDATE target_private.profiles SET total_points=10000000000000,casino_net=10000000000000 WHERE member_id=$1',[actor.memberId]);
 const bounded=await hashes();eq((await rpc('credit',{...actor,sessionId:'bound_12345678',reps:1})).error.code,'INCOME_LIMIT');eq(await hashes(),bounded,'income limit rejection is atomic');
 await db.query('UPDATE target_private.profiles SET total_points=6000,casino_net=6000 WHERE member_id=$1',[actor.memberId]);
 await reconcile();
 await db.query(await fs.readFile(path.join(root,'supabase/tests/weight_rewards_verify.sql'),'utf8'));
 checks++;
 const fn=(await db.query("SELECT md5(prosrc) hash FROM pg_proc WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure")).rows[0].hash;
 console.log(JSON.stringify({passed:true,checks,migration,projectionHash:fn,hostedRequests:0,acceptedHostedMutations:0}));
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1;}).finally(async()=>{if(db)await db.end();if(admin){if(created)await admin.query('DROP DATABASE "'+database+'"');await admin.end();}});
