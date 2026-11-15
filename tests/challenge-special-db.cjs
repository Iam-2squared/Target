'use strict';
// Synthetic identities in one disposable localhost database. No hosted writes.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {Client}=require('pg');
const {questionBlock}=require('../server/challenge.cjs');
const root=path.resolve(__dirname,'..');
const migrationName='20261115114526_target_challenge_ten_combo_special.sql';
const uid=()=>crypto.randomUUID(),secret=crypto.randomBytes(40).toString('hex');
const dbName='target_special_'+process.pid+'_'+crypto.randomBytes(4).toString('hex')+'_test';
const actor=name=>({memberId:uid(),name,sessionHash:crypto.randomBytes(32).toString('hex')});
const main=actor('Ten Combo'),old=actor('Old Receipt'),nextTen=actor('Existing Nine'),nextTwenty=actor('Existing Nineteen'),finisher=actor('Special Finisher');
let admin,db,other,created=false,checks=0,lastInput;
const eq=(a,b,label)=>{checks++;assert.deepEqual(a,b,label);};
const ok=(value,label)=>{checks++;assert(value,label);};
async function rpc(who,action,params={},client=db){
 const input={...who,...params};
 if(['start','answer','pause','resume','abort'].includes(action)&&!input.requestId)input.requestId=uid();
 return (await client.query('SELECT public.target_challenge_rpc($1,$2,$3::jsonb) x',[secret,action,JSON.stringify(input)])).rows[0].x;
}
async function wallet(who){return(await db.query('SELECT target_private.games_wallet($1) x',[who.memberId])).rows[0].x;}
async function runRow(id){return(await db.query('SELECT to_jsonb(r) x FROM target_private.challenge_runs r WHERE id=$1',[id])).rows[0].x;}
async function put(who,run){
 if(run.status==='playing'&&!run.question){const result=await rpc(who,'next',{runId:run.id,questions:questionBlock(run.level)});ok(result.ok,JSON.stringify(result));return result.run;}
 return run;
}
async function state(who,id){const result=await rpc(who,'state',{runId:id});ok(result.ok);return result.run;}
async function answerInput(who,run,correct=true){
 run=await put(who,run);
 const q=(await runRow(run.id)).questions[0];
 return {requestId:uid(),runId:run.id,questionId:q.id,choiceId:correct?q.correctChoiceId:q.choices.find(c=>c.id!==q.correctChoiceId).id};
}
async function hit(who,run,correct=true){
 lastInput=await answerInput(who,run,correct);
 // Make combat assertions independent of local machine speed. This is a private
 // fixture adjustment; the HTTP/API never accepts a client-provided clock.
 await db.query("UPDATE target_private.challenge_runs SET next_attack_at=clock_timestamp()+(CASE WHEN level=10 THEN 2000 ELSE 3000-100*(level-1) END)*interval '1 millisecond' WHERE id=$1",[run.id]);
 const result=await rpc(who,'answer',lastInput);ok(result.ok,JSON.stringify(result));return result;
}
async function seeded(who,{level=10,streak=0,hp=500,enemy=100*level,status='playing'}={}){
 const id=(await db.query("INSERT INTO target_private.challenge_runs(member_id,level,status,player_hp,enemy_hp,streak,correct_count,sequence,attack_remaining_ms) VALUES($1,$2::integer,$3,$4,$5,$6,$6,$6,CASE WHEN $2::integer=10 THEN 2000 ELSE 3000-100*($2::integer-1) END) RETURNING id",[who.memberId,level,status,hp,enemy,streak])).rows[0].id;
 let run=await state(who,id);
 if(status==='playing')run=await put(who,run);
 return run;
}
async function snapshot(){
 const tables=(await db.query("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='target_private' AND c.relkind='r' ORDER BY c.relname")).rows;
 const result={};
 for(const {relname} of tables){
  assert(/^[a-z0-9_]+$/.test(relname));
  result[relname]=(await db.query("SELECT md5(coalesce(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text),'')) hash FROM target_private."+relname+' t')).rows[0].hash;
 }
 return result;
}
function metadata(answer,{special=false,power=0,extra=0,correct=true,heal=0,bonus=false}={}){
 eq(answer.specialAttack,special);eq(answer.specialPower,power);eq(answer.specialDamage,extra);
 eq(answer.damage,correct?5:10,'existing damage metadata remains the nominal base hit/self-damage');
 eq(answer.correct,correct);eq(answer.healedHp,heal);eq(answer.streakBonus,bonus);
}
async function reconcile(){
 eq((await db.query('SELECT count(*)::int n FROM target_private.profiles p JOIN target_private.wallet_finance_projection(NULL) f USING(member_id) WHERE (p.total_points,p.spent_points,p.casino_net) IS DISTINCT FROM (f.total_points,f.spent_points,f.casino_net)')).rows[0].n,0,'all wallets reconcile with the latest finance projection');
 eq((await db.query("SELECT md5(prosrc) hash FROM pg_proc WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure")).rows[0].hash,'bd93399757a066fdfb8f35e7e29af2dc','latest Epic/Legendary finance implementation is untouched');
}
async function run(){
 eq(process.env.NODE_ENV,'test');
 const url=new URL(process.env.DATABASE_URL||'');
 ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&!url.search&&!url.hash,'fresh loopback database only');
 const adminUrl=new URL(url);adminUrl.pathname='/postgres';admin=new Client({connectionString:adminUrl.href});await admin.connect();
 await admin.query('CREATE DATABASE "'+dbName+'"');created=true;
 url.pathname='/'+dbName;db=new Client({connectionString:url.href});other=new Client({connectionString:url.href});await db.connect();await other.connect();
 await db.query("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF; END $$");
 const migrations=path.join(root,'supabase/migrations');
 // Install the complete existing financial release before this new patch, as on
 // Production. The new migration also supports chronological fresh installs.
 for(const file of(await fs.readdir(migrations)).filter(x=>/^\d+_.*\.sql$/.test(x)&&x!==migrationName).sort())await db.query(await fs.readFile(path.join(migrations,file),'utf8'));
 await db.query("INSERT INTO target_private.server_credentials(singleton,key_hash) VALUES(true,encode(sha256(convert_to($1,'UTF8')),'hex'))",[secret]);
 for(const who of[main,old,nextTen,nextTwenty,finisher])await db.query('INSERT INTO target_private.profiles(member_id,name) VALUES($1,$2)',[who.memberId,who.name]);
 // Preserve an actual pre-migration answer receipt at streak ten. No retroactive
 // special may be awarded when this run resumes or the old answer is replayed.
 let oldRun=await seeded(old,{level:3,streak:9,hp:160,enemy:255});
 let result=await hit(old,oldRun);oldRun=result.run;
 eq(oldRun.streak,10);eq(oldRun.enemyHp,250);eq(result.answer.streakBonus,true);
 ok(!Object.hasOwn(result.answer,'specialAttack'),'the existing receipt has its original answer schema');
 const oldInput={...lastInput},oldAnswer=result.answer;
 oldRun=(await rpc(old,'pause',{runId:oldRun.id})).run;
 const oldReceipt=(await db.query('SELECT to_jsonb(q) x FROM target_private.challenge_requests q WHERE member_id=$1 AND request_id=$2',[old.memberId,oldInput.requestId])).rows[0].x;
 const nine=await seeded(nextTen,{level:3,streak:9,hp:195,enemy:255});
 let nineteen=await seeded(nextTwenty,{level:10,streak:19,hp:545,enemy:800});
 nineteen=(await rpc(nextTwenty,'pause',{runId:nineteen.id})).run;
 const before=await snapshot();
 const financeBefore=(await db.query("SELECT prosrc FROM pg_proc WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure")).rows[0].prosrc;
 await db.query(await fs.readFile(path.join(migrations,migrationName),'utf8'));
 eq(await snapshot(),before,'migration changes zero existing rows, including active progress and immutable history');
 eq((await db.query("SELECT prosrc FROM pg_proc WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure")).rows[0].prosrc,financeBefore,'migration preserves financial function byte-for-byte');
 eq((await db.query("SELECT md5(prosrc) hash FROM pg_proc WHERE oid='public.target_challenge_rpc(text,text,jsonb)'::regprocedure")).rows[0].hash,'55c8efdd3b70cd967de68842f4b55871');
 const replayOld=await rpc(old,'answer',oldInput);
 eq(replayOld.replayed,true);eq(replayOld.answer,oldAnswer,'old request replays its original metadata without new special fields');
 eq(replayOld.run.streak,10);eq(replayOld.run.enemyHp,250);eq(replayOld.run.status,'paused');
 eq((await db.query('SELECT to_jsonb(q) x FROM target_private.challenge_requests q WHERE member_id=$1 AND request_id=$2',[old.memberId,oldInput.requestId])).rows[0].x,oldReceipt,'preexisting receipt is never rewritten');
 oldRun=(await rpc(old,'resume',{runId:oldRun.id})).run;
 result=await hit(old,oldRun);metadata(result.answer);eq(result.run.streak,11);eq(result.run.enemyHp,245,'streak already ten does not receive a retroactive special');
 result=await hit(nextTen,await state(nextTen,nine.id));
 metadata(result.answer,{special:true,power:30,extra:30,heal:5,bonus:true});eq(result.run.streak,10);eq(result.run.enemyHp,220);eq(result.run.playerHp,200,'existing nine streak gains special and capped fifth-answer heal together');
 nineteen=(await rpc(nextTwenty,'resume',{runId:nineteen.id})).run;
 eq(nineteen.streak,19);eq(nineteen.enemyHp,800);eq(nineteen.question.id,(await runRow(nineteen.id)).questions[0].id);
 result=await hit(nextTwenty,nineteen);
 metadata(result.answer,{special:true,power:100,extra:100,heal:5,bonus:true});eq(result.run.streak,20);eq(result.run.enemyHp,695);eq(result.run.playerHp,550,'existing nineteen streak resumes into its twentieth-answer special');
 // Exercise the real consecutive-answer sequence through both ten and twenty.
 let current=await seeded(main);
 for(let n=1;n<=20;n++){
  const hpBefore=current.enemyHp;result=await hit(main,current);current=result.run;
  metadata(result.answer,{special:n%10===0,power:n%10===0?100:0,extra:n%10===0?100:0,heal:n%5===0?10:0,bonus:n%5===0});
  eq(current.enemyHp,hpBefore-5-(n%10===0?100:0));eq(current.streak,n);
  if(n===9)eq(current.enemyHp,955,'ninth correct answer has only the ordinary five damage');
  if(n===10){
   const accepted={...lastInput},hp=current.enemyHp,walletBefore=await wallet(main);
   const duplicates=await Promise.all([rpc(main,'answer',accepted),rpc(main,'answer',accepted,other)]);
   for(const duplicate of duplicates){eq(duplicate.replayed,true);eq(duplicate.run.enemyHp,hp);metadata(duplicate.answer,{special:true,power:100,extra:100,heal:10,bonus:true});eq(duplicate.wallet,walletBefore);}
  }
 }
 eq(current.enemyHp,700);eq(current.playerHp,540);
 result=await hit(main,current);current=result.run;metadata(result.answer);eq(current.streak,21);
 result=await hit(main,current,false);current=result.run;metadata(result.answer,{correct:false});eq(current.streak,0);eq(result.answer.enemyHealedHp,10);
 for(let n=1;n<=9;n++){result=await hit(main,current);current=result.run;metadata(result.answer,{heal:n===5?10:0,bonus:n===5});}
 eq(current.correctCount,30);eq(current.streak,9);eq(result.answer.specialAttack,false,'lifetime correct count thirty cannot substitute for ten consecutive correct answers');
 result=await hit(main,current);current=result.run;metadata(result.answer,{special:true,power:100,extra:100,heal:10,bonus:true});eq(current.correctCount,31);eq(current.streak,10);eq(current.enemyHp,555);
 // The bonus can finish a run. Concurrent same-ID delivery earns one receipt,
 // one shared-wallet credit and one unique badge, with actual damage capped.
 let finish=await seeded(finisher,{level:1,streak:9,hp:90,enemy:12});
 let input=await answerInput(finisher,finish);
 const finals=await Promise.all([rpc(finisher,'answer',input),rpc(finisher,'answer',input,other)]);
 eq(finals.filter(x=>x.replayed===true).length,1);
 for(const won of finals){ok(won.ok);metadata(won.answer,{special:true,power:10,extra:7,heal:10,bonus:true});eq(won.run.enemyHp,0);eq(won.run.status,'won');eq(won.wallet.totalIncome,100000);eq(won.wallet.balance,100000);eq(won.wallet.walletRevision,1);}
 eq((await db.query('SELECT count(*)::int n FROM target_private.challenge_reward_events WHERE run_id=$1',[finish.id])).rows[0].n,1);
 eq((await db.query('SELECT count(*)::int n FROM target_private.challenge_badges WHERE member_id=$1',[finisher.memberId])).rows[0].n,1);
 eq((await db.query('SELECT total_points=casino_net AND total_points=100000 exact FROM target_private.profiles WHERE member_id=$1',[finisher.memberId])).rows[0].exact,true);
 const stale=await rpc(finisher,'answer',{...input,requestId:uid()});eq(stale.error.code,'CHALLENGE_NOT_PLAYING');
 let repeated=(await rpc(finisher,'start',{level:1})).run;
 await db.query('UPDATE target_private.challenge_runs SET streak=9,correct_count=9,enemy_hp=12,player_hp=100 WHERE id=$1',[repeated.id]);
 repeated=await state(finisher,repeated.id);input=await answerInput(finisher,repeated);
 const winners=await Promise.all([rpc(finisher,'answer',input),rpc(finisher,'answer',{...input,requestId:uid()},other)]);
 eq(winners.filter(x=>x.ok).length,1,'different concurrent IDs still accept only one finishing answer');
 const winner=winners.find(x=>x.ok);metadata(winner.answer,{special:true,power:10,extra:7,bonus:true});eq(winner.badgeAwarded,false);eq(winner.wallet.totalIncome,200000);eq(winner.wallet.walletRevision,2);
 eq((await db.query('SELECT count(*)::int n FROM target_private.challenge_badges WHERE member_id=$1',[finisher.memberId])).rows[0].n,1,'repeat special wins never duplicate the level badge');
 // A ten-combo that already kills with the base hit reports zero extra damage.
 repeated=(await rpc(finisher,'start',{level:1})).run;
 await db.query('UPDATE target_private.challenge_runs SET streak=9,correct_count=9,enemy_hp=3,player_hp=100 WHERE id=$1',[repeated.id]);
 result=await hit(finisher,await state(finisher,repeated.id));
 metadata(result.answer,{special:true,power:10,extra:0,bonus:true});eq(result.run.enemyHp,0);eq(result.run.status,'won');eq(result.wallet.totalIncome,300000);
 // Every level uses maximum enemy HP, even when its current HP is lower.
 const levelFixtures=[];
 for(let level=1;level<=10;level++){
  const who=actor('Level '+level+' Special'),maxHp=100+50*(level-1);
  await db.query('INSERT INTO target_private.profiles(member_id,name) VALUES($1,$2)',[who.memberId,who.name]);
  const fixture=await seeded(who,{level,streak:9,hp:maxHp-5});
  result=await hit(who,fixture);
  metadata(result.answer,{special:true,power:10*level,extra:10*level,heal:5,bonus:true});
  eq(result.run.enemyHp,100*level-5-10*level);eq(result.run.playerHp,maxHp);
  levelFixtures.push({who,run:result.run});
 }
 // A special finisher still respects the existing wallet ceiling. The failed
 // operation consumes no question/streak/damage and can retry its original ID.
 const adjust=async(totalIncome)=>db.query('SELECT target_private.adjust_wallet_income($1,$2::jsonb)',[
  'income_adjust_special_'+crypto.randomBytes(8).toString('hex'),JSON.stringify({version:1,reason:'Disposable special finisher ceiling fixture',targets:[{memberId:finisher.memberId,expectedName:finisher.name,totalIncome}]})]);
 await adjust(10000000000000);
 repeated=(await rpc(finisher,'start',{level:1})).run;
 await db.query('UPDATE target_private.challenge_runs SET streak=9,correct_count=9,enemy_hp=12,player_hp=100 WHERE id=$1',[repeated.id]);
 repeated=await state(finisher,repeated.id);input=await answerInput(finisher,repeated);
 const cappedRun=await runRow(repeated.id),cappedWallet=await wallet(finisher);
 result=await rpc(finisher,'answer',input);
 eq(result.error.code,'CHALLENGE_WALLET_LIMIT');eq(await runRow(repeated.id),cappedRun);eq(await wallet(finisher),cappedWallet);
 eq((await db.query('SELECT count(*)::int n FROM target_private.challenge_requests WHERE member_id=$1 AND request_id=$2',[finisher.memberId,input.requestId])).rows[0].n,0);
 await adjust(10000000000000-100000);
 result=await rpc(finisher,'answer',input);ok(result.ok);metadata(result.answer,{special:true,power:10,extra:7,bonus:true});eq(result.wallet.totalIncome,10000000000000);
 // A late capacity failure rolls back the special, heal, reward, badge and
 // accounting together, even after the existing award path has executed.
 const capacity=levelFixtures[0];
 await db.query("UPDATE target_private.challenge_runs SET streak=19,correct_count=19,enemy_hp=12,player_hp=90,next_attack_at=clock_timestamp()+interval '3 seconds' WHERE id=$1",[capacity.run.id]);
 input=await answerInput(capacity.who,await state(capacity.who,capacity.run.id));
 await db.query("CREATE FUNCTION target_private.special_capacity_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced special receipt capacity' USING ERRCODE='54000'; END $$; CREATE TRIGGER special_capacity_fixture BEFORE INSERT ON target_private.challenge_requests FOR EACH ROW EXECUTE FUNCTION target_private.special_capacity_fixture()");
 const beforeCapacity=await snapshot();result=await rpc(capacity.who,'answer',input);
 eq(result.error.code,'CAPACITY_LIMIT');eq(await snapshot(),beforeCapacity,'late 507 fully rolls back special damage, heal, win, wallet, badge and quota');
 await db.query('DROP TRIGGER special_capacity_fixture ON target_private.challenge_requests; DROP FUNCTION target_private.special_capacity_fixture()');
 result=await rpc(capacity.who,'answer',input);ok(result.ok);metadata(result.answer,{special:true,power:10,extra:7,heal:10,bonus:true});eq(result.run.status,'won');eq(result.wallet.totalIncome,100000);
 await reconcile();
 await assert.rejects(()=>db.query('UPDATE target_private.challenge_requests SET response=response WHERE member_id=$1 AND request_id=$2',[old.memberId,oldInput.requestId]),{code:'42501'});checks++;
 await db.query(await fs.readFile(path.join(root,'supabase/tests/challenge_levels_verify.sql'),'utf8'));checks++;
 console.log('Challenge ten-combo PostgreSQL checks passed:',checks);
}
run().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
 await Promise.allSettled([db?.end(),other?.end()]);
 if(created&&admin)await admin.query('DROP DATABASE "'+dbName+'" WITH (FORCE)');
 await admin?.end();
});
