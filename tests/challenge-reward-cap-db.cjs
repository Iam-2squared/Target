'use strict';
// Synthetic history in a fresh loopback database only. Never hosted data.
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs/promises');
const path=require('node:path');
const {Client}=require('pg');
const {questionBlock}=require('../server/challenge.cjs');
const root=path.resolve(__dirname,'..');
const migrationName='20261115232731_target_challenge_three_lifetime_rewarded_clears.sql';
const uid=()=>crypto.randomUUID(),secret=crypto.randomBytes(40).toString('hex');
const dbName='target_reward_cap_'+process.pid+'_'+crypto.randomBytes(4).toString('hex')+'_test';
const actor=name=>({memberId:uid(),name,sessionHash:crypto.randomBytes(32).toString('hex')});
const fresh=actor('Fresh Capped Rewards'),second=actor('Independent Rewards');
const historical=actor('Grandfathered Five'),reset=actor('Reset Badge History');
const ceiling=actor('Zero At Wallet Limit'),eligible=actor('Paid At Wallet Limit');
const actors=[fresh,second,historical,reset,ceiling,eligible];
let admin,db,other,created=false,checks=0,baselineBytes=0n,lastInput;
const eq=(a,b,label)=>{checks++;assert.deepEqual(a,b,label);};
const ok=(value,label)=>{checks++;assert(value,label);};
async function rpc(who,action,params={},client=db){
 const input={...who,...params};
 if(['start','answer','pause','resume','abort'].includes(action)&&!input.requestId)input.requestId=uid();
 return(await client.query('SELECT public.target_challenge_rpc($1,$2,$3::jsonb) x',[secret,action,JSON.stringify(input)])).rows[0].x;
}
async function row(id){return(await db.query('SELECT to_jsonb(r) x FROM target_private.challenge_runs r WHERE id=$1',[id])).rows[0].x;}
async function profile(who){return(await db.query('SELECT to_jsonb(p) x FROM target_private.profiles p WHERE member_id=$1',[who.memberId])).rows[0].x;}
async function wallet(who){return(await db.query('SELECT target_private.games_wallet($1) x',[who.memberId])).rows[0].x;}
async function start(who,level=1){const value=await rpc(who,'start',{level});ok(value.ok,JSON.stringify(value));return value.run;}
async function supply(who,run){
 if(run.status==='playing'&&!run.question){const value=await rpc(who,'next',{runId:run.id,questions:questionBlock(run.level)});ok(value.ok,JSON.stringify(value));return value.run;}
 return run;
}
async function inputFor(who,run,correct=true){
 run=await supply(who,run);const q=(await row(run.id)).questions[0];ok(q,'private fixture has a current question');
 await db.query("UPDATE target_private.challenge_runs SET next_attack_at=clock_timestamp()+(CASE WHEN level>=6 THEN 3000-200*(level-5) ELSE 3000 END)*interval '1 millisecond' WHERE id=$1",[run.id]);
 return {requestId:uid(),runId:run.id,questionId:q.id,choiceId:correct?q.correctChoiceId:q.choices.find(c=>c.id!==q.correctChoiceId).id};
}
async function hit(who,run,correct=true){lastInput=await inputFor(who,run,correct);const value=await rpc(who,'answer',lastInput);ok(value.ok,JSON.stringify(value));return value;}
async function readyWin(who,level=1,fields={}){
 let run=await supply(who,await start(who,level));
 await db.query('UPDATE target_private.challenge_runs SET enemy_hp=$2,streak=$3,correct_count=$3,player_hp=$4 WHERE id=$1',
  [run.id,fields.enemy??5,fields.streak??0,fields.hp??100+50*(level-1)]);
 return run;
}
async function win(who,level=1){return hit(who,await readyWin(who,level));}
async function count(who,level=1){return(await db.query('SELECT count(*)::int n FROM target_private.challenge_reward_events WHERE member_id=$1 AND level=$2',[who.memberId,level])).rows[0].n;}
async function receipt(who,input){return(await db.query('SELECT to_jsonb(q) x FROM target_private.challenge_requests q WHERE member_id=$1 AND request_id=$2',[who.memberId,input.requestId])).rows[0]?.x;}
async function snapshot(){
 const names=(await db.query("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='target_private' AND c.relkind='r' ORDER BY c.relname")).rows;
 const hashes={};for(const {relname}of names){assert(/^[a-z0-9_]+$/.test(relname));hashes[relname]=(await db.query("SELECT md5(coalesce(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text),'')) h FROM target_private."+relname+' t')).rows[0].h;}return hashes;
}
async function schema(){
 return(await db.query(`SELECT jsonb_build_object(
  'tables',(SELECT jsonb_agg(jsonb_build_array(c.relname,c.relrowsecurity,c.relacl) ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='target_private' AND c.relkind='r'),
  'columns',(SELECT jsonb_agg(jsonb_build_array(c.relname,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid)) ORDER BY c.relname,a.attnum) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE n.nspname='target_private' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped),
  'indexes',(SELECT jsonb_agg(jsonb_build_array(tablename,indexname,indexdef) ORDER BY tablename,indexname) FROM pg_indexes WHERE schemaname='target_private'),
  'constraints',(SELECT jsonb_agg(jsonb_build_array(c.conrelid::regclass::text,c.conname,pg_get_constraintdef(c.oid),c.convalidated) ORDER BY c.conrelid::regclass::text,c.conname) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='target_private' AND NOT(c.conrelid='target_private.challenge_runs'::regclass AND c.contype='c' AND position('won' IN pg_get_constraintdef(c.oid))>0)),
  'triggers',(SELECT jsonb_agg(jsonb_build_array(t.tgrelid::regclass::text,t.tgname,t.tgenabled::text,pg_get_triggerdef(t.oid)) ORDER BY t.tgrelid::regclass::text,t.tgname) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='target_private' AND NOT t.tgisinternal)
 ) x`)).rows[0].x;
}
async function functions(){return(await db.query("SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_array(md5(p.prosrc),p.prosecdef,p.proconfig,p.proacl)) x FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','target_private')")).rows[0].x;}
async function logical(){return BigInt((await db.query('SELECT logical_bytes x FROM target_private.system_state WHERE singleton')).rows[0].x);}
async function challengeBytes(){
 const tables=['challenge_runs','challenge_badges','challenge_reward_events','challenge_requests','challenge_rates'];
 return BigInt((await db.query('SELECT coalesce(sum(bytes),0)::bigint x FROM ('+tables.map(t=>'SELECT pg_column_size(to_jsonb(t))+128'+(t==='challenge_requests'?"+CASE WHEN action='answer' AND response#>>'{answer,correct}'='false' AND jsonb_typeof(response#>'{answer,mistake}')='object' THEN 128 ELSE 0 END":'')+' bytes FROM target_private.'+t+' t').join(' UNION ALL ')+') retained')).rows[0].x);
}
async function accounting(){eq(await logical(),baselineBytes+await challengeBytes(),'shared quota exactly charges retained challenge rows, including mistake index entries');}
async function rebaseAccounting(){baselineBytes=await logical()-await challengeBytes();}
async function reconcile(){eq((await db.query('SELECT count(*)::int n FROM target_private.profiles p JOIN target_private.wallet_finance_projection(NULL) f USING(member_id) WHERE (p.total_points,p.spent_points,p.casino_net) IS DISTINCT FROM (f.total_points,f.spent_points,f.casino_net)')).rows[0].n,0,'wallet caches reconcile with immutable financial history');}
function counters(value,paid){eq(value.rewardLimit,3);eq(value.rewardedClears,paid);eq(value.rewardsRemaining,Math.max(0,3-paid));}
async function mapLevel(who,level,paid){const value=await rpc(who,'map');ok(value.ok);const item=value.levels[level-1];counters(item,paid);eq(item.reward,paid<3?level*100000:0);return item;}
function cleared(value,reward,badge){
 ok(value.ok,JSON.stringify(value));eq(value.cleared,true,'only the newly winning answer has a clear receipt');eq(value.reward,reward);eq(value.badgeAwarded,badge);
 eq(value.run.status,'won');eq(value.run.enemyHp,0);eq(value.run.reward,reward);eq(value.run.badgeAwarded,badge);eq(value.run.question,null);
}
function noWinningMarker(value){for(const key of ['cleared','reward','badgeAwarded'])ok(!Object.hasOwn(value,key),'nonwinning response has no '+key+' marker');}
async function adjust(who,totalIncome){await db.query('SELECT target_private.adjust_wallet_income($1,$2::jsonb)',[
 'income_adjust_cap_'+crypto.randomBytes(8).toString('hex'),JSON.stringify({version:1,reason:'Disposable challenge lifetime-cap ceiling fixture',targets:[{memberId:who.memberId,expectedName:who.name,totalIncome}]})]);await rebaseAccounting();}
async function rejectsVerifierDrift(verifyBody,mutate,message){
 const before=await snapshot(),schemaBefore=await schema();await db.query('BEGIN');
 try{
  await db.query('ALTER TABLE target_private.challenge_requests DISABLE TRIGGER challenge_requests_immutable');
  eq((await db.query("SELECT tgenabled::text x FROM pg_trigger WHERE tgrelid='target_private.challenge_requests'::regclass AND tgname='challenge_requests_storage'")).rows[0].x,'O','drift fixture keeps receipt accounting enabled');
  await mutate();
  await db.query('ALTER TABLE target_private.challenge_requests ENABLE TRIGGER challenge_requests_immutable');
  await assert.rejects(()=>db.query(verifyBody),error=>error.code==='P0001'&&error.message===message);checks++;
 }finally{await db.query('ROLLBACK');}
 eq(await snapshot(),before,'rejected verifier drift restores every row and shared quota exactly');
 eq(await schema(),schemaBefore,'rejected verifier drift restores all guards, indexes and constraints exactly');await accounting();
}
async function main(){
 eq(process.env.NODE_ENV,'test');const url=new URL(process.env.DATABASE_URL||'');
 ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&!url.search&&!url.hash,'fresh disposable loopback database only');
 const owner=new URL(url);owner.pathname='/postgres';admin=new Client({connectionString:owner.href});await admin.connect();
 await admin.query('CREATE DATABASE "'+dbName+'"');created=true;url.pathname='/'+dbName;
 db=new Client({connectionString:url.href});other=new Client({connectionString:url.href});await db.connect();await other.connect();
 await db.query("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF; END $$");
 const dir=path.join(root,'supabase/migrations');
 // Install every current release, including the prior progress reset, before
 // creating historical paid timelines. Never reapply that reset to the history.
 for(const file of(await fs.readdir(dir)).filter(f=>/^\d+_.*\.sql$/.test(f)&&f!==migrationName).sort())await db.query(await fs.readFile(path.join(dir,file),'utf8'));
 await db.query("INSERT INTO target_private.server_credentials(singleton,key_hash) VALUES(true,encode(sha256(convert_to($1,'UTF8')),'hex'))",[secret]);
 for(const who of actors)await db.query('INSERT INTO target_private.profiles(member_id,name) VALUES($1,$2)',[who.memberId,who.name]);
 await rebaseAccounting();
 let oldWin,oldWinningInput;
 for(let n=0;n<5;n++){oldWin=await win(historical);eq(oldWin.reward,100000);if(n===4)oldWinningInput={...lastInput};}
 for(let n=0;n<3;n++){eq((await win(reset)).reward,100000);eq((await win(ceiling)).reward,100000);}
 for(let n=0;n<3;n++)eq((await win(historical,2)).reward,200000);
 const oldWinningReceipt=await receipt(historical,oldWinningInput);
 let priorRun=await supply(historical,await start(historical));const oldNonwinning=await hit(historical,priorRun,false);priorRun=oldNonwinning.run;
 const oldNonwinningInput={...lastInput},oldNonwinningReceipt=await receipt(historical,oldNonwinningInput);noWinningMarker(oldNonwinning);
 ok(typeof oldNonwinningReceipt.response.answer.mistake==='object','historical wrong answer has a private review snapshot');
 ok(!Object.hasOwn(oldNonwinning.answer,'mistake'));eq(oldNonwinning.run.mistakes,[]);
 ok(!JSON.stringify(oldNonwinning).includes('correctText'),'private correct text stays absent from live public feedback');
 // Model an existing reset badge without touching money/history. Only this
 // specifically named immutable guard is disabled, in this local fixture.
 await db.query('BEGIN');
 try{
  await db.query('ALTER TABLE target_private.challenge_badges DISABLE TRIGGER challenge_badges_immutable');
  eq((await db.query('DELETE FROM target_private.challenge_badges WHERE member_id=$1 AND level=1 RETURNING member_id',[reset.memberId])).rowCount,1);
  await db.query('ALTER TABLE target_private.challenge_badges ENABLE TRIGGER challenge_badges_immutable');await db.query('COMMIT');
 }catch(error){await db.query('ROLLBACK');throw error;}
 await assert.rejects(()=>db.query('DELETE FROM target_private.challenge_badges WHERE member_id=$1',[historical.memberId]),{code:'42501'});checks++;
 await reconcile();await accounting();
 const before=await snapshot(),schemaBefore=await schema(),functionsBefore=await functions();
 const grandfatheredWallet=await wallet(historical),grandfatheredProfile=await profile(historical);
 const migration=await fs.readFile(path.join(dir,migrationName),'utf8');ok(migration.trim().length>0,'lifetime-cap migration is populated');
 await db.query(migration);
 eq(await snapshot(),before,'cap migration performs zero row DML, preserving every profile, clock, reward, badge and immutable receipt');
 eq(await schema(),schemaBefore,'all existing schemas, grants, indexes, positive-only rewards, 16KiB receipts and storage guards remain unchanged except the won-run check');
 const functionsAfter=await functions();
 const rpcSignature=Object.hasOwn(functionsAfter,'public.target_challenge_rpc(text,text,jsonb)')?'public.target_challenge_rpc(text,text,jsonb)':'target_challenge_rpc(text,text,jsonb)';
 eq(functionsAfter[rpcSignature][0],'389b08b44def976556235f3efaff5c52');
 eq(functionsAfter['target_private.challenge_dto(uuid,uuid)'][0],'331e412e43afba33ef27123bcded9bce');
 for(const [name,definition]of Object.entries(functionsBefore))if(!['target_challenge_rpc(text,text,jsonb)','public.target_challenge_rpc(text,text,jsonb)','target_private.challenge_dto(uuid,uuid)'].includes(name))eq(functionsAfter[name],definition,'migration preserves function '+name);
 eq(Object.keys(functionsAfter).sort(),Object.keys(functionsBefore).sort(),'cap counters require no new database functions');
 eq(await profile(historical),grandfatheredProfile);eq(await wallet(historical),grandfatheredWallet);
 eq(await count(historical),5,'existing five paid clears remain grandfathered');await mapLevel(historical,1,5);await mapLevel(historical,2,3);await mapLevel(reset,1,3);
 let replay=await rpc(historical,'answer',oldWinningInput);eq(replay.replayed,true);eq(replay.reward,100000);ok(!Object.hasOwn(replay,'cleared'),'old immutable winning receipt gains no new marker');
 eq(await receipt(historical,oldWinningInput),oldWinningReceipt);
 const oldBadgeCount=(await db.query('SELECT count(*)::int n FROM target_private.challenge_badges WHERE member_id=$1',[historical.memberId])).rows[0].n;
 await db.query('UPDATE target_private.challenge_runs SET enemy_hp=5 WHERE id=$1',[priorRun.id]);
 const newZero=await hit(historical,priorRun);cleared(newZero,0,false);counters(newZero.run,5);eq(await wallet(historical),grandfatheredWallet);eq(await profile(historical),grandfatheredProfile);eq(await count(historical),5);
 eq((await db.query('SELECT count(*)::int n FROM target_private.challenge_badges WHERE member_id=$1',[historical.memberId])).rows[0].n,oldBadgeCount);
 replay=await rpc(historical,'answer',oldNonwinningInput);eq(replay.replayed,true);eq(replay.run.status,'won');noWinningMarker(replay);eq(replay.answer,oldNonwinning.answer);eq(await receipt(historical,oldNonwinningInput),oldNonwinningReceipt);ok(!JSON.stringify(replay).includes('correctText'),'historical wrong-answer replay redacts its private review snapshot');
 // A fresh member receives exactly three lifetime rewards at this level.
 await mapLevel(fresh,1,0);
 for(let n=1;n<=2;n++){
  let active=await readyWin(fresh);counters(active,n-1);eq(active.reward,0);let earlierInput,earlierReceipt;
  if(n===1){
   await db.query('UPDATE target_private.challenge_runs SET enemy_hp=100 WHERE id=$1',[active.id]);
   const earlier=await hit(fresh,active);noWinningMarker(earlier);earlierInput={...lastInput};earlierReceipt=await receipt(fresh,earlierInput);active=earlier.run;
   await db.query('UPDATE target_private.challenge_runs SET enemy_hp=5 WHERE id=$1',[active.id]);
  }
  const value=await hit(fresh,active);cleared(value,100000,n===1);counters(value.run,n);eq(value.wallet.totalIncome,n*100000);eq(value.wallet.walletRevision,n);await mapLevel(fresh,1,n);
  if(earlierInput){const earlierReplay=await rpc(fresh,'answer',earlierInput);eq(earlierReplay.replayed,true);eq(earlierReplay.run.status,'won');eq(earlierReplay.run.reward,100000);noWinningMarker(earlierReplay);eq(await receipt(fresh,earlierInput),earlierReceipt);}
 }
 let run=await readyWin(fresh),input=await inputFor(fresh,run);
 const third=await Promise.all([rpc(fresh,'answer',input),rpc(fresh,'answer',input,other)]);
 eq(third.filter(r=>r.replayed===true).length,1,'concurrent same UUID pays exactly once');
 for(const value of third){cleared(value,100000,false);counters(value.run,3);eq(value.wallet.totalIncome,300000);eq(value.wallet.walletRevision,3);}
 eq(await count(fresh),3);eq((await receipt(fresh,input)).response.cleared,true);await mapLevel(fresh,1,3);
 const paidWallet=await wallet(fresh),paidProfile=await profile(fresh);
 run=await readyWin(fresh);counters(run,3);input=await inputFor(fresh,run);
 const competingInput={...input,requestId:uid()};
 const fourth=await Promise.all([rpc(fresh,'answer',input),rpc(fresh,'answer',competingInput,other)]);
 eq(fourth.filter(r=>r.ok).length,1,'concurrent different finishers accept one clear');eq(fourth.find(r=>!r.ok).error.code,'CHALLENGE_NOT_PLAYING');
 const zero=fourth.find(r=>r.ok);cleared(zero,0,false);counters(zero.run,3);eq(await count(fresh),3);eq(await profile(fresh),paidProfile);eq(zero.wallet,paidWallet);
 const acceptedInput=fourth[0].ok?input:competingInput;
 const zeroReceipt=await receipt(fresh,acceptedInput);
 const duplicates=await Promise.all([rpc(fresh,'answer',acceptedInput),rpc(fresh,'answer',acceptedInput,other)]);
 for(const value of duplicates){eq(value.replayed,true);cleared(value,0,false);eq(value.wallet,paidWallet);}
 eq(await receipt(fresh,acceptedInput),zeroReceipt,'zero-clear retry never rewrites the immutable receipt');
 for(let n=0;n<8;n++){cleared(await win(fresh),0,false);eq(await count(fresh),3);eq(await profile(fresh),paidProfile);}
 const otherLevel=await win(fresh,2);cleared(otherLevel,200000,true);counters(otherLevel.run,1);await mapLevel(fresh,1,3);await mapLevel(fresh,2,1);
 const otherMember=await win(second);cleared(otherMember,100000,true);counters(otherMember.run,1);await mapLevel(second,1,1);
 await reconcile();await accounting();
 // A cap exhausted before the reset still restores progression with no money.
 eq((await rpc(reset,'start',{level:2})).error.code,'CHALLENGE_LOCKED');
 run=await supply(reset,await start(reset));const nonwinning=await hit(reset,run);noWinningMarker(nonwinning);const nonwinningInput={...lastInput};run=nonwinning.run;
 await db.query("UPDATE target_private.challenge_runs SET streak=19,correct_count=19,enemy_hp=12,player_hp=90,next_attack_at=clock_timestamp()+interval '3 seconds' WHERE id=$1",[run.id]);
 input=await inputFor(reset,run);const resetWallet=await wallet(reset),resetProfile=await profile(reset);
 await db.query(`CREATE FUNCTION target_private.reward_cap_failure_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
  IF NEW.response->>'cleared' IS DISTINCT FROM 'true' OR NEW.response->>'reward' IS DISTINCT FROM '0' OR NEW.response->>'badgeAwarded' IS DISTINCT FROM 'true'
   OR NOT EXISTS(SELECT 1 FROM target_private.challenge_runs r WHERE r.id=NEW.run_id AND r.status='won' AND r.reward=0 AND r.questions='[]'::jsonb)
   OR NOT EXISTS(SELECT 1 FROM target_private.challenge_badges b WHERE b.run_id=NEW.run_id)
   OR EXISTS(SELECT 1 FROM target_private.challenge_reward_events e WHERE e.run_id=NEW.run_id) THEN
   RAISE EXCEPTION 'late capacity fixture did not observe the completed zero-clear'; END IF;
  RAISE EXCEPTION 'forced AFTER receipt zero-clear rollback' USING ERRCODE='54000';
 END $$;
 CREATE TRIGGER zz_reward_cap_failure_fixture AFTER INSERT ON target_private.challenge_requests FOR EACH ROW EXECUTE FUNCTION target_private.reward_cap_failure_fixture()`);
 const rollbackBefore=await snapshot();const failed=await rpc(reset,'answer',input);eq(failed.error.code,'CAPACITY_LIMIT');ok(!Object.hasOwn(failed,'cleared'));
 eq(await snapshot(),rollbackBefore,'AFTER receipt failure rolls back zero-clear marker, special damage/heal, question consumption, new badge, receipts, rate and storage accounting');
 eq(await receipt(reset,input),undefined);eq(await wallet(reset),resetWallet);eq(await profile(reset),resetProfile);
 await db.query('DROP TRIGGER zz_reward_cap_failure_fixture ON target_private.challenge_requests; DROP FUNCTION target_private.reward_cap_failure_fixture()');
 const special=await rpc(reset,'answer',input);cleared(special,0,true);counters(special.run,3);eq(special.answer.specialAttack,true);eq(special.answer.specialPercent,20);eq(special.answer.specialPower,20);eq(special.answer.specialDamage,7);eq(special.answer.healedHp,10);eq(special.answer.specialPaused,false);eq(special.answer.specialPausedAt,null);
 eq(special.wallet,resetWallet);eq(await profile(reset),resetProfile);eq(await count(reset),3);
 eq((await mapLevel(reset,1,3)).cleared,true);eq((await mapLevel(reset,2,0)).unlocked,true);
 replay=await rpc(reset,'answer',nonwinningInput);eq(replay.replayed,true);eq(replay.run.status,'won');noWinningMarker(replay);
 replay=await rpc(reset,'answer',input);eq(replay.replayed,true);cleared(replay,0,true);eq(replay.answer,special.answer);
 eq((await db.query('SELECT count(*)::int n FROM target_private.challenge_badges WHERE member_id=$1',[reset.memberId])).rows[0].n,1);
 await reconcile();await accounting();
 // Exhausted rewards bypass every monetary update and headroom guard, even at
 // both the wallet and revision ceiling. Eligible rewards still reject at507.
 await adjust(ceiling,10000000000000);
 await db.query('UPDATE target_private.profiles SET wallet_revision=10000000000000 WHERE member_id=$1',[ceiling.memberId]);
 run=await readyWin(ceiling);input=await inputFor(ceiling,run);const ceilingProfile=await profile(ceiling),ceilingWallet=await wallet(ceiling);
 await db.query(`CREATE FUNCTION target_private.reward_cap_money_guard_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN RAISE EXCEPTION 'zero-clear attempted a monetary profile update'; END $$;
 CREATE TRIGGER reward_cap_money_guard_fixture BEFORE UPDATE OF total_points,casino_net,spent_points,wallet_revision ON target_private.profiles
 FOR EACH ROW WHEN (OLD.member_id='${ceiling.memberId}'::uuid) EXECUTE FUNCTION target_private.reward_cap_money_guard_fixture()`);
 const ceilingClear=await rpc(ceiling,'answer',input);cleared(ceilingClear,0,false);eq(ceilingClear.wallet,ceilingWallet);eq(await profile(ceiling),ceilingProfile);eq(await count(ceiling),3);
 await db.query('DROP TRIGGER reward_cap_money_guard_fixture ON target_private.profiles; DROP FUNCTION target_private.reward_cap_money_guard_fixture()');
 await adjust(eligible,10000000000000);
 run=await readyWin(eligible);input=await inputFor(eligible,run);const eligibleRun=await row(run.id),eligibleWallet=await wallet(eligible),eligibleProfile=await profile(eligible);
 const rejected=await rpc(eligible,'answer',input);eq(rejected.error.code,'CHALLENGE_WALLET_LIMIT');eq(rejected.error.status,507);ok(!Object.hasOwn(rejected,'cleared'));
 eq(await row(run.id),eligibleRun);eq(await wallet(eligible),eligibleWallet);eq(await profile(eligible),eligibleProfile);eq(await receipt(eligible,input),undefined);eq(await count(eligible),0);
 await adjust(eligible,10000000000000-100000);
 const retried=await rpc(eligible,'answer',input);cleared(retried,100000,true);eq(retried.wallet.totalIncome,10000000000000);eq(await count(eligible),1);
 await reconcile();await accounting();
 await assert.rejects(()=>db.query('DELETE FROM target_private.challenge_reward_events WHERE member_id=$1',[historical.memberId]),{code:'42501'});checks++;
 await assert.rejects(()=>db.query('UPDATE target_private.challenge_requests SET response=response WHERE member_id=$1',[fresh.memberId]),{code:'42501'});checks++;
 const verifySql=await fs.readFile(path.join(root,'supabase/tests/challenge_levels_verify.sql'),'utf8');
 await db.query(verifySql);checks++;
 // Preserve the verifier's SQL checks while leaving transaction ownership with
 // each rollback-only drift fixture, so even an unexpectedly passing verifier
 // cannot commit a deliberately corrupted historical receipt.
 const verifyBody=verifySql.replace(/^BEGIN;\s*$/m,'').replace(/^COMMIT;\s*$/m,'');
 ok(verifyBody!==verifySql&&!/^BEGIN;\s*$|^COMMIT;\s*$/m.test(verifyBody),'postflight transaction wrapper is removed only for rollback fixtures');
 const fourthHistorical=(await db.query(`WITH paid AS (
  SELECT run_id,row_number() OVER(PARTITION BY member_id,level ORDER BY created_at,run_id) ordinal
  FROM target_private.challenge_reward_events WHERE member_id=$1 AND level=1 AND amount>0)
  SELECT q.request_id,q.response FROM paid p JOIN target_private.challenge_requests q USING(run_id)
  WHERE p.ordinal=4 AND q.action='answer' AND q.response->'reward'='100000'::jsonb`,[historical.memberId])).rows;
 eq(fourthHistorical.length,1);ok(!Object.hasOwn(fourthHistorical[0].response,'cleared'),'historical ordinal-four paid clear remains unmarked and passes the clean verifier');eq(await count(historical),5);
 await rejectsVerifierDrift(verifyBody,async()=>{
  eq((await db.query("UPDATE target_private.challenge_requests SET response=response||jsonb_build_object('cleared',true) WHERE member_id=$1 AND request_id=$2 RETURNING request_id",[historical.memberId,fourthHistorical[0].request_id])).rowCount,1);
 },'Challenge newly paid clear exceeds its lifetime reward limit');
 await rejectsVerifierDrift(verifyBody,async()=>{
  eq((await db.query("UPDATE target_private.challenge_requests SET response=response-'cleared' WHERE member_id=$1 AND request_id=$2 AND response->'cleared'='true'::jsonb RETURNING request_id",[fresh.memberId,acceptedInput.requestId])).rowCount,1);
 },'Challenge zero-reward win needs one authoritative winning answer receipt');
 await db.query(verifySql);checks++;
 console.log('Challenge lifetime reward-cap PostgreSQL checks passed:',checks);
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
 await Promise.allSettled([db?.end(),other?.end()]);
 if(created&&admin)try{await admin.query('DROP DATABASE "'+dbName+'" WITH (FORCE)');}catch(error){console.error('fixture cleanup failed:',error.message);process.exitCode=1;}
 await admin?.end();
});
