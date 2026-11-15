'use strict';
// Synthetic identities in one disposable localhost database. No hosted writes.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {Client}=require('pg');
const {questionBlock}=require('../server/challenge.cjs');
const root=path.resolve(__dirname,'..');
const migrationName='20261115131403_target_challenge_special_animation_pause.sql';
const feedbackMigration='20261115142451_target_challenge_graded_choice_feedback.sql';
const reviewMigration='20261115144738_target_challenge_defeat_mistake_review.sql';
const resetMigration='20261115150438_target_challenge_progress_reset_and_late_level_pace.sql';
const capMigration='20261115232731_target_challenge_three_lifetime_rewarded_clears.sql';
const uid=()=>crypto.randomUUID(),secret=crypto.randomBytes(40).toString('hex');
const dbName='target_special_'+process.pid+'_'+crypto.randomBytes(4).toString('hex')+'_test';
const actor=name=>({memberId:uid(),name,sessionHash:crypto.randomBytes(32).toString('hex')});
const main=actor('Ten Combo'),old=actor('Old Receipt'),nextTen=actor('Existing Nine'),nextTwenty=actor('Existing Nineteen'),finisher=actor('Special Finisher');
let admin,db,other,created=false,checks=0,lastInput,upgraded=true;
const oldPace=()=>3000;
const specialOrigins=new Map();
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
 if(run.status==='paused'){
  const source=specialOrigins.get(run.id);
  const resumed=await rpc(who,'resume',{runId:run.id,...(source?{specialRequestId:source}:{})});
  ok(resumed.ok,JSON.stringify(resumed));run=resumed.run;
 }
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
 await db.query("UPDATE target_private.challenge_runs SET next_attack_at=clock_timestamp()+$2*interval '1 millisecond' WHERE id=$1",[run.id,upgraded?3000:oldPace(run.level)]);
 const result=await rpc(who,'answer',lastInput);ok(result.ok,JSON.stringify(result));
 if(result.answer?.specialPaused){
  specialOrigins.set(run.id,lastInput.requestId);
  eq(result.run.status,'paused');eq(result.run.question,null);eq(result.answer.specialPausedAt,result.run.updatedAt);
 }
 return result;
}
async function seeded(who,{level=10,streak=0,hp=500,enemy=100*level,status='playing'}={}){
 const id=(await db.query("INSERT INTO target_private.challenge_runs(member_id,level,status,player_hp,enemy_hp,streak,correct_count,sequence,attack_remaining_ms) VALUES($1,$2::integer,$3,$4,$5,$6,$6,$6,$7) RETURNING id",[who.memberId,level,status,hp,enemy,streak,upgraded?3000:oldPace(level)])).rows[0].id;
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
function metadata(answer,{special=false,power=0,extra=0,correct=true,heal=0,bonus=false,percent=special?10:0,paused=special}={}){
 eq(answer.specialAttack,special);eq(answer.specialPower,power);eq(answer.specialDamage,extra);
 eq(answer.specialPercent,percent);
 eq(answer.specialPaused,paused);
 if(paused)ok(typeof answer.specialPausedAt==='string');else eq(answer.specialPausedAt,null);
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
 const newMigrationSql=await fs.readFile(path.join(migrations,migrationName),'utf8');
 // Install the complete existing financial release before this new patch, as on
 // Production. The new migration also supports chronological fresh installs.
 for(const file of(await fs.readdir(migrations)).filter(x=>/^\d+_.*\.sql$/.test(x)&&![migrationName,feedbackMigration,reviewMigration,resetMigration,capMigration].includes(x)).sort())await db.query(await fs.readFile(path.join(migrations,file),'utf8'));
 await db.query("INSERT INTO target_private.server_credentials(singleton,key_hash) VALUES(true,encode(sha256(convert_to($1,'UTF8')),'hex'))",[secret]);
 for(const who of[main,old,nextTen,nextTwenty,finisher])await db.query('INSERT INTO target_private.profiles(member_id,name) VALUES($1,$2)',[who.memberId,who.name]);
 // Preserve an actual fixed-ten-percent answer receipt at streak twenty. No retroactive
 // special may be awarded when this run resumes or the old answer is replayed.
 let oldRun=await seeded(old,{level:3,streak:19,hp:160,enemy:255});
 let result=await hit(old,oldRun);oldRun=result.run;
 eq(oldRun.streak,20);eq(oldRun.enemyHp,190);eq(result.answer.streakBonus,true);
 eq(result.answer.specialPower,60,'the historical twentieth-answer special keeps its growing power');
 ok(!Object.hasOwn(result.answer,'specialPaused'),'the existing receipt has its original answer schema');
 const oldInput={...lastInput},oldAnswer=result.answer;
 oldRun=(await rpc(old,'pause',{runId:oldRun.id})).run;
 const oldReceipt=(await db.query('SELECT to_jsonb(q) x FROM target_private.challenge_requests q WHERE member_id=$1 AND request_id=$2',[old.memberId,oldInput.requestId])).rows[0].x;
 const nine=await seeded(nextTen,{level:3,streak:9,hp:195,enemy:255});
 let nineteen=await seeded(nextTwenty,{level:10,streak:19,hp:545,enemy:800});
 nineteen=(await rpc(nextTwenty,'pause',{runId:nineteen.id})).run;
 const oldWinner=actor('Historical Winner');
 await db.query('INSERT INTO target_private.profiles(member_id,name) VALUES($1,$2)',[oldWinner.memberId,oldWinner.name]);
 const terminal=await seeded(oldWinner,{level:1,streak:9,hp:100,enemy:3});
 eq((await hit(oldWinner,terminal)).run.status,'won','terminal history exists before migration');
 const clocks=[];
 for(let level=1;level<=10;level++)for(const status of ['playing','paused']){
  const who=actor('Clock '+level+' '+status);
  await db.query('INSERT INTO target_private.profiles(member_id,name) VALUES($1,$2)',[who.memberId,who.name]);
  const fixture=await seeded(who,{level,status,hp:100+50*(level-1)});
  await db.query("UPDATE target_private.challenge_runs SET attack_remaining_ms=$2::integer,next_attack_at=CASE WHEN status='playing' THEN clock_timestamp()+$2::integer*interval '1 millisecond' ELSE NULL END WHERE id=$1",[fixture.id,oldPace(level)-250]);
  clocks.push({who,id:fixture.id,level,status});
 }
 const before=await snapshot(),beforeRows=(await db.query('SELECT to_jsonb(r) x FROM target_private.challenge_runs r ORDER BY id')).rows.map(row=>row.x);
 const beforeBytes=Number((await db.query('SELECT sum(pg_column_size(to_jsonb(r))+128)::bigint bytes FROM target_private.challenge_runs r')).rows[0].bytes);
 const beforeSystem=(await db.query('SELECT to_jsonb(s) x FROM target_private.system_state s')).rows[0].x;
 const financeBefore=(await db.query("SELECT prosrc FROM pg_proc WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure")).rows[0].prosrc;
 await db.query(newMigrationSql);
 upgraded=true;
 const after=await snapshot(),afterRows=(await db.query('SELECT to_jsonb(r) x FROM target_private.challenge_runs r ORDER BY id')).rows.map(row=>row.x);
 eq(after,before,'animation pause migration modifies zero preexisting rows, clocks, receipts, balances or progress');
 for(const table of Object.keys(before).filter(name=>!['challenge_runs','system_state'].includes(name)))eq(after[table],before[table],'migration preserves every non-clock row: '+table);
 for(let i=0;i<beforeRows.length;i++){
  const a=afterRows[i],b=beforeRows[i],delta=b.level>1&&['playing','paused'].includes(b.status)?3000-oldPace(b.level):0;
  const stable=row=>{const {next_attack_at,attack_remaining_ms,...rest}=row;return rest;};
  eq(stable(a),stable(b),'only scheduled or saved clock columns may change');
  eq(a.attack_remaining_ms,b.attack_remaining_ms+(b.next_attack_at===null?delta:0));
  if(b.next_attack_at!==null)eq(Number((await db.query('SELECT extract(epoch FROM (next_attack_at-$2::timestamptz))*1000 delay FROM target_private.challenge_runs WHERE id=$1',[a.id,b.next_attack_at])).rows[0].delay),delta);
  else eq(a.next_attack_at,null);
 }
 const afterBytes=Number((await db.query('SELECT sum(pg_column_size(to_jsonb(r))+128)::bigint bytes FROM target_private.challenge_runs r')).rows[0].bytes);
 const afterSystem=(await db.query('SELECT to_jsonb(s) x FROM target_private.system_state s')).rows[0].x;
 eq({...afterSystem,logical_bytes:beforeSystem.logical_bytes},beforeSystem);
 eq(Number(afterSystem.logical_bytes)-Number(beforeSystem.logical_bytes),afterBytes-beforeBytes,'only actual clock-row storage differences affect the shared quota');
 eq((await db.query("SELECT prosrc FROM pg_proc WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure")).rows[0].prosrc,financeBefore,'migration preserves financial function byte-for-byte');
 eq((await db.query("SELECT md5(prosrc) hash FROM pg_proc WHERE oid='public.target_challenge_rpc(text,text,jsonb)'::regprocedure")).rows[0].hash,'b74f38f7d92fc6839eeaf854292f4f12');
 eq((await rpc(main,'map')).levels.map(row=>row.attackIntervalMs),Array(10).fill(3000),'map reports exactly three seconds at every level');
 for(const fixture of clocks){
  if(fixture.status==='playing'){
   const maxHp=100+50*(fixture.level-1),damage=fixture.level===10?15:5+(fixture.level-1);
   await db.query("UPDATE target_private.challenge_runs SET next_attack_at=clock_timestamp()-interval '6100 milliseconds' WHERE id=$1",[fixture.id]);
   let active=await state(fixture.who,fixture.id);eq(active.attackIntervalMs,3000);eq(active.playerHp,maxHp-3*damage,'server tick uses three-second cadence for this level');
   ok(active.nextAttackInMs>2500&&active.nextAttackInMs<=3000);
   active=(await rpc(fixture.who,'pause',{runId:fixture.id})).run;
   const remainder=active.nextAttackInMs,hp=active.playerHp;
   await db.query('SELECT pg_sleep(0.01)');const paused=await state(fixture.who,fixture.id);
   eq(paused.nextAttackInMs,remainder);eq(paused.playerHp,hp);eq(paused.question,null);
   active=(await rpc(fixture.who,'resume',{runId:fixture.id})).run;
   ok(active.nextAttackInMs<=remainder&&active.nextAttackInMs>remainder-100);eq(active.playerHp,hp);eq(active.attackIntervalMs,3000);
  }else{
   let active=await state(fixture.who,fixture.id);eq(active.nextAttackInMs,2750,'paused fractional progress extends to the same three-second cycle');
   active=(await rpc(fixture.who,'resume',{runId:fixture.id})).run;active=await put(fixture.who,active);
   eq(active.attackIntervalMs,3000);ok(active.nextAttackInMs>2500&&active.nextAttackInMs<=2750);
  }
  await rpc(fixture.who,'abort',{runId:fixture.id});
 }
 const replayOld=await rpc(old,'answer',oldInput);
 eq(replayOld.replayed,true);eq(replayOld.answer,oldAnswer,'old request replays its original metadata without new special fields');
 eq(replayOld.run.streak,20);eq(replayOld.run.enemyHp,190);eq(replayOld.run.status,'paused');
 eq((await rpc(old,'resume',{runId:oldRun.id,specialRequestId:oldInput.requestId})).error.code,'CHALLENGE_SPECIAL_CHANGED','a pre-animation answer receipt cannot own a current pause');
 eq((await db.query('SELECT to_jsonb(q) x FROM target_private.challenge_requests q WHERE member_id=$1 AND request_id=$2',[old.memberId,oldInput.requestId])).rows[0].x,oldReceipt,'preexisting receipt is never rewritten');
 oldRun=(await rpc(old,'resume',{runId:oldRun.id})).run;
 result=await hit(old,oldRun);metadata(result.answer);eq(result.run.streak,21);eq(result.run.enemyHp,185,'an existing twentieth-answer special is not recalculated retroactively');
 result=await hit(nextTen,await state(nextTen,nine.id));
 metadata(result.answer,{special:true,power:30,extra:30,heal:5,bonus:true});eq(result.run.streak,10);eq(result.run.enemyHp,220);eq(result.run.playerHp,200,'existing nine streak gains special and capped fifth-answer heal together');
 nineteen=(await rpc(nextTwenty,'resume',{runId:nineteen.id})).run;
 eq(nineteen.streak,19);eq(nineteen.enemyHp,800);eq(nineteen.question.id,(await runRow(nineteen.id)).questions[0].id);
 result=await hit(nextTwenty,nineteen);
 metadata(result.answer,{special:true,power:200,extra:200,heal:5,bonus:true,percent:20});eq(result.run.streak,20);eq(result.run.enemyHp,595);eq(result.run.playerHp,550,'existing nineteen streak resumes into its growing twentieth-answer special');
 // Exercise the real consecutive-answer sequence through both ten and twenty.
 let current=await seeded(main);
 for(let n=1;n<=20;n++){
  const hpBefore=current.enemyHp;result=await hit(main,current);current=result.run;
  metadata(result.answer,{special:n%10===0,power:n%10===0?n*10:0,extra:n%10===0?n*10:0,heal:n%5===0?10:0,bonus:n%5===0,percent:n%10===0?n:0});
  eq(current.enemyHp,hpBefore-5-(n%10===0?n*10:0));eq(current.streak,n);
  if(n===9)eq(current.enemyHp,955,'ninth correct answer has only the ordinary five damage');
  if(n===10){
   eq((await runRow(current.id)).questions.length,0,'a special at the end of a block preserves the empty pending-question phase');
   const accepted={...lastInput},hp=current.enemyHp,walletBefore=await wallet(main);
   const duplicates=await Promise.all([rpc(main,'answer',accepted),rpc(main,'answer',accepted,other)]);
   for(const duplicate of duplicates){eq(duplicate.replayed,true);eq(duplicate.run.enemyHp,hp);metadata(duplicate.answer,{special:true,power:100,extra:100,heal:10,bonus:true});eq(duplicate.wallet,walletBefore);}
  }
 }
 eq(current.enemyHp,600);eq(current.playerHp,540);
 result=await hit(main,current);current=result.run;metadata(result.answer);eq(current.streak,21);
 result=await hit(main,current,false);current=result.run;metadata(result.answer,{correct:false});eq(current.streak,0);eq(result.answer.enemyHealedHp,10);
 for(let n=1;n<=9;n++){result=await hit(main,current);current=result.run;metadata(result.answer,{heal:n===5?10:0,bonus:n===5});}
 eq(current.correctCount,30);eq(current.streak,9);eq(result.answer.specialAttack,false,'lifetime correct count thirty cannot substitute for ten consecutive correct answers');
 result=await hit(main,current);current=result.run;metadata(result.answer,{special:true,power:100,extra:100,heal:10,bonus:true});eq(current.correctCount,31);eq(current.streak,10);eq(current.enemyHp,455);
 // The bonus can finish a run. Concurrent same-ID delivery earns one receipt,
 // one shared-wallet credit and one unique badge, with actual damage capped.
 let finish=await seeded(finisher,{level:1,streak:9,hp:90,enemy:12});
 let input=await answerInput(finisher,finish);
 const finals=await Promise.all([rpc(finisher,'answer',input),rpc(finisher,'answer',input,other)]);
 eq(finals.filter(x=>x.replayed===true).length,1);
 for(const won of finals){ok(won.ok);metadata(won.answer,{special:true,power:10,extra:7,heal:10,bonus:true,paused:false});eq(won.run.enemyHp,0);eq(won.run.status,'won');eq(won.wallet.totalIncome,100000);eq(won.wallet.balance,100000);eq(won.wallet.walletRevision,1);}
 eq((await db.query('SELECT count(*)::int n FROM target_private.challenge_reward_events WHERE run_id=$1',[finish.id])).rows[0].n,1);
 eq((await db.query('SELECT count(*)::int n FROM target_private.challenge_badges WHERE member_id=$1',[finisher.memberId])).rows[0].n,1);
 eq((await db.query('SELECT total_points=casino_net AND total_points=100000 exact FROM target_private.profiles WHERE member_id=$1',[finisher.memberId])).rows[0].exact,true);
 const stale=await rpc(finisher,'answer',{...input,requestId:uid()});eq(stale.error.code,'CHALLENGE_NOT_PLAYING');
 let repeated=(await rpc(finisher,'start',{level:1})).run;
 await db.query('UPDATE target_private.challenge_runs SET streak=9,correct_count=9,enemy_hp=12,player_hp=100 WHERE id=$1',[repeated.id]);
 repeated=await state(finisher,repeated.id);input=await answerInput(finisher,repeated);
 const winners=await Promise.all([rpc(finisher,'answer',input),rpc(finisher,'answer',{...input,requestId:uid()},other)]);
 eq(winners.filter(x=>x.ok).length,1,'different concurrent IDs still accept only one finishing answer');
 const winner=winners.find(x=>x.ok);metadata(winner.answer,{special:true,power:10,extra:7,bonus:true,paused:false});eq(winner.badgeAwarded,false);eq(winner.wallet.totalIncome,200000);eq(winner.wallet.walletRevision,2);
 eq((await db.query('SELECT count(*)::int n FROM target_private.challenge_badges WHERE member_id=$1',[finisher.memberId])).rows[0].n,1,'repeat special wins never duplicate the level badge');
 // A ten-combo that already kills with the base hit reports zero extra damage.
 repeated=(await rpc(finisher,'start',{level:1})).run;
 await db.query('UPDATE target_private.challenge_runs SET streak=9,correct_count=9,enemy_hp=3,player_hp=100 WHERE id=$1',[repeated.id]);
 result=await hit(finisher,await state(finisher,repeated.id));
 metadata(result.answer,{special:true,power:10,extra:0,bonus:true,paused:false});eq(result.run.enemyHp,0);eq(result.run.status,'won');eq(result.wallet.totalIncome,300000);
 // Every level uses maximum enemy HP, even when its current HP is lower.
 const levelFixtures=[];
 for(let level=1;level<=10;level++){
  const who=actor('Level '+level+' Special'),maxHp=100+50*(level-1);
  await db.query('INSERT INTO target_private.profiles(member_id,name) VALUES($1,$2)',[who.memberId,who.name]);
  const fixture=await seeded(who,{level,streak:9,hp:maxHp-5});
  result=await hit(who,fixture);
  metadata(result.answer,{special:true,power:10*level,extra:10*level,heal:5,bonus:true});
  eq(result.run.enemyHp,100*level-5-10*level);eq(result.run.playerHp,maxHp);
  const pausedRow=await runRow(fixture.id),pausedWallet=await wallet(who);
  eq(pausedRow.next_attack_at,null);ok(pausedRow.attack_remaining_ms>0&&pausedRow.attack_remaining_ms<=3000);
  eq(result.answer.specialPausedAt,result.run.updatedAt);
  await db.query("SELECT target_private.challenge_tick($1,clock_timestamp()+interval '1 day')",[fixture.id]);
  eq(await runRow(fixture.id),pausedRow,'a whole day of elapsed server time cannot attack an animation-paused run');
  eq(await wallet(who),pausedWallet);
  const denied=await rpc(who,'answer',{requestId:uid(),runId:fixture.id,questionId:uid(),choiceId:uid()});
  eq(denied.error.code,'CHALLENGE_NOT_PLAYING');eq(await runRow(fixture.id),pausedRow,'paused answers cannot change HP, questions or streak');
  levelFixtures.push({who,run:result.run});
 }
 // The pause ownership receipt survives a lost ACK, and guarded resume closes
 // the race with newer/manual pause intent without adding state columns.
 const fx=actor('Fractional FX');
 await db.query('INSERT INTO target_private.profiles(member_id,name) VALUES($1,$2)',[fx.memberId,fx.name]);
 let fxRun=await seeded(fx,{level:3,streak:9,hp:180,enemy:300});
 await db.query("UPDATE target_private.challenge_runs SET questions=jsonb_build_array(questions->0),next_attack_at=clock_timestamp()+interval '1250 milliseconds' WHERE id=$1",[fxRun.id]);
 const fxInput=await answerInput(fx,fxRun),fxResult=await rpc(fx,'answer',fxInput);ok(fxResult.ok);
 metadata(fxResult.answer,{special:true,power:30,extra:30,heal:10,bonus:true});
 fxRun=fxResult.run;eq(fxRun.status,'paused');eq(fxRun.question,null);
 const frozen=await runRow(fxRun.id),fraction=frozen.attack_remaining_ms;
 ok(fraction>1000&&fraction<=1250);eq(frozen.questions.length,0);eq(frozen.next_attack_at,null);
 const firstReplay=await rpc(fx,'answer',fxInput);eq(firstReplay.replayed,true);eq(firstReplay.answer,fxResult.answer);eq(firstReplay.run.updatedAt,fxResult.answer.specialPausedAt);
 await db.query("SELECT target_private.challenge_tick($1,clock_timestamp()+interval '1 day')",[fxRun.id]);
 eq(await runRow(fxRun.id),frozen);
 const autoIds=[uid(),uid()];
 const resumed=await Promise.all(autoIds.map((requestId,i)=>rpc(fx,'resume',{requestId,runId:fxRun.id,specialRequestId:fxInput.requestId},i?other:db)));
 eq(resumed.filter(x=>x.ok).length,1,'concurrent automatic resumes accept only the current pause owner once');
 eq(resumed.find(x=>!x.ok).error.code,'CHALLENGE_SPECIAL_CHANGED');
 const resumeId=autoIds[resumed.findIndex(x=>x.ok)];
 fxRun=resumed.find(x=>x.ok).run;eq(fxRun.status,'playing');eq(fxRun.question,null);eq(fxRun.nextAttackInMs,fraction);
 fxRun=await put(fx,fxRun);ok(fxRun.nextAttackInMs>1000&&fxRun.nextAttackInMs<=fraction);
 eq(fxRun.questionSequence,frozen.sequence+1,'resuming an empty block issues exactly one replacement question');
 const expectedQuestion=fxRun.question.id;
 const manualPauseId=uid();fxRun=(await rpc(fx,'pause',{requestId:manualPauseId,runId:fxRun.id})).run;
 ok(fxRun.updatedAt!==fxResult.answer.specialPausedAt);
 const manualRow=await runRow(fxRun.id);
 const staleReplay=await rpc(fx,'answer',fxInput);eq(staleReplay.answer.specialPaused,true);eq(staleReplay.run.status,'paused');ok(staleReplay.run.updatedAt!==staleReplay.answer.specialPausedAt);
 eq((await rpc(fx,'resume',{requestId:uid(),runId:fxRun.id,specialRequestId:fxInput.requestId})).error.code,'CHALLENGE_SPECIAL_CHANGED');
 eq(await runRow(fxRun.id),manualRow,'an old answer receipt cannot resume a newer manual pause');
 const resumedReplay=await rpc(fx,'resume',{requestId:resumeId,runId:fxRun.id,specialRequestId:fxInput.requestId});eq(resumedReplay.replayed,true);eq(resumedReplay.run.status,'paused');eq(await runRow(fxRun.id),manualRow,'retrying an accepted automatic resume never resumes a newer manual pause');
 eq((await rpc(fx,'pause',{requestId:manualPauseId,runId:fxRun.id})).replayed,true);eq(await runRow(fxRun.id),manualRow,'duplicate pause UUID does not change pause ownership');
 const newerPause=(await rpc(fx,'pause',{requestId:uid(),runId:fxRun.id})).run;ok(newerPause.updatedAt!==fxRun.updatedAt,'a fresh manual pause invalidates ownership even when already paused');
 eq((await rpc(fx,'resume',{runId:fxRun.id,specialRequestId:manualPauseId})).error.code,'CHALLENGE_SPECIAL_CHANGED','a manual pause receipt is not special-answer ownership');
 eq((await rpc(fx,'resume',{runId:fxRun.id,specialRequestId:uid()})).error.code,'CHALLENGE_SPECIAL_CHANGED');
 eq((await rpc(fx,'resume',{runId:fxRun.id,specialRequestId:'invalid'})).error.code,'INVALID_CHALLENGE_REQUEST');
 const continued=(await rpc(fx,'resume',{runId:fxRun.id})).run;eq(continued.status,'playing');eq(continued.question.id,expectedQuestion,'manual Continue retains the queued next question');
 eq((await rpc(main,'resume',{runId:current.id,specialRequestId:fxInput.requestId})).error.code,'CHALLENGE_SPECIAL_CHANGED','another member cannot use the pause receipt');
 await rpc(fx,'abort',{runId:fxRun.id});
 const otherRun=(await rpc(fx,'start',{level:1})).run;await rpc(fx,'pause',{runId:otherRun.id});
 eq((await rpc(fx,'resume',{runId:otherRun.id,specialRequestId:fxInput.requestId})).error.code,'CHALLENGE_SPECIAL_CHANGED','a receipt cannot own another run');
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
 result=await rpc(finisher,'answer',input);ok(result.ok);metadata(result.answer,{special:true,power:10,extra:7,bonus:true,paused:false});eq(result.wallet.totalIncome,10000000000000);
 // A late capacity failure rolls back the special, heal, reward, badge and
 // accounting together, even after the existing award path has executed.
 const capacity=levelFixtures[0];
 capacity.run=await put(capacity.who,capacity.run);
 await db.query("UPDATE target_private.challenge_runs SET streak=19,correct_count=19,enemy_hp=12,player_hp=90,next_attack_at=clock_timestamp()+interval '3 seconds' WHERE id=$1",[capacity.run.id]);
 input=await answerInput(capacity.who,await state(capacity.who,capacity.run.id));
 await db.query("CREATE FUNCTION target_private.special_capacity_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced special receipt capacity' USING ERRCODE='54000'; END $$; CREATE TRIGGER special_capacity_fixture BEFORE INSERT ON target_private.challenge_requests FOR EACH ROW EXECUTE FUNCTION target_private.special_capacity_fixture()");
 const beforeCapacity=await snapshot();result=await rpc(capacity.who,'answer',input);
 eq(result.error.code,'CAPACITY_LIMIT');eq(await snapshot(),beforeCapacity,'late 507 fully rolls back special damage, heal, win, wallet, badge and quota');
 await db.query('DROP TRIGGER special_capacity_fixture ON target_private.challenge_requests; DROP FUNCTION target_private.special_capacity_fixture()');
 result=await rpc(capacity.who,'answer',input);ok(result.ok);metadata(result.answer,{special:true,power:20,extra:7,heal:10,bonus:true,percent:20,paused:false});eq(result.run.status,'won');eq(result.wallet.totalIncome,100000);
 const nonwinning=levelFixtures[1];nonwinning.run=await put(nonwinning.who,nonwinning.run);
 await db.query("UPDATE target_private.challenge_runs SET streak=19,correct_count=19,enemy_hp=200,player_hp=140,next_attack_at=clock_timestamp()+interval '1500 milliseconds' WHERE id=$1",[nonwinning.run.id]);
 input=await answerInput(nonwinning.who,await state(nonwinning.who,nonwinning.run.id));
 await db.query("CREATE FUNCTION target_private.special_capacity_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced special pause receipt capacity' USING ERRCODE='54000'; END $$; CREATE TRIGGER special_capacity_fixture BEFORE INSERT ON target_private.challenge_requests FOR EACH ROW EXECUTE FUNCTION target_private.special_capacity_fixture()");
 const beforePauseCapacity=await snapshot();result=await rpc(nonwinning.who,'answer',input);
 eq(result.error.code,'CAPACITY_LIMIT');eq(await snapshot(),beforePauseCapacity,'late 507 also rolls back a nonwinning animation pause, ownership timestamp, heal and damage');
 await db.query('DROP TRIGGER special_capacity_fixture ON target_private.challenge_requests; DROP FUNCTION target_private.special_capacity_fixture()');
 result=await rpc(nonwinning.who,'answer',input);ok(result.ok);metadata(result.answer,{special:true,power:40,extra:40,heal:10,bonus:true,percent:20});
 eq(result.run.status,'paused');eq(result.run.enemyHp,155);eq(result.run.playerHp,150);eq(result.wallet.totalIncome,0);
 // Confirm every new start is 3000 ms while earning the prerequisite badges.
 // Levels 1-9 use controlled HP fixtures; level 10 then exercises all 40 real
 // consecutive answers, including the increasing twentieth/thirtieth specials.
 const milestones=actor('Growing Milestones');
 await db.query('INSERT INTO target_private.profiles(member_id,name) VALUES($1,$2)',[milestones.memberId,milestones.name]);
 for(let level=1;level<=9;level++){
  let started=(await rpc(milestones,'start',{level})).run;
  eq(started.attackIntervalMs,3000);eq(started.nextAttackInMs,3000);
  started=await put(milestones,started);ok(started.nextAttackInMs>2800&&started.nextAttackInMs<=3000);
  await db.query('UPDATE target_private.challenge_runs SET enemy_hp=5 WHERE id=$1',[started.id]);
  eq((await hit(milestones,started)).run.status,'won');
 }
 let growing=(await rpc(milestones,'start',{level:10})).run;eq(growing.attackIntervalMs,3000);eq(growing.nextAttackInMs,3000);
 let historicalTwenty;
 for(let n=1;n<=40;n++){
  const special=n%10===0,power=special?n*10:0,extra=Math.min(power,Math.max(0,growing.enemyHp-5)),heal=n%5===0?Math.min(10,550-growing.playerHp):0;
  result=await hit(milestones,growing);growing=result.run;
  metadata(result.answer,{special,power,extra,heal,bonus:n%5===0,percent:special?n:0,paused:special&&n<40});eq(growing.streak,n);
  if(n===20)historicalTwenty={...lastInput};
  if(n===30){eq(growing.enemyHp,250);eq(result.answer.specialPower,300);}
  if(n===40){eq(result.answer.specialPower,400);eq(result.answer.specialDamage,200);eq(growing.enemyHp,0);eq(growing.status,'won');}
 }
 const earlier=await rpc(milestones,'answer',historicalTwenty);eq(earlier.replayed,true);eq(earlier.answer.specialPercent,20);eq(earlier.answer.specialPower,200);ok(!Object.hasOwn(earlier,'reward'),'an old nonwinning special replay never gains a later winning reward receipt');
 for(const streak of [99,109]){
  const who=actor('Beyond '+streak);
  await db.query('INSERT INTO target_private.profiles(member_id,name) VALUES($1,$2)',[who.memberId,who.name]);
  const fixture=await seeded(who,{level:1,streak,hp:100,enemy:12});result=await hit(who,fixture);
  metadata(result.answer,{special:true,power:streak+1,extra:7,bonus:true,percent:streak+1,paused:false});eq(result.run.status,'won');
 }
 await reconcile();
 await assert.rejects(()=>db.query('UPDATE target_private.challenge_requests SET response=response WHERE member_id=$1 AND request_id=$2',[old.memberId,oldInput.requestId]),{code:'42501'});checks++;
 const beforeFeedback=await snapshot();
 await db.query(await fs.readFile(path.join(migrations,feedbackMigration),'utf8'));
 eq(await snapshot(),beforeFeedback,'correction metadata migration leaves every historical row and active run unchanged');
 await db.query(await fs.readFile(path.join(migrations,reviewMigration),'utf8'));
 eq(await snapshot(),beforeFeedback,'defeat review migration does not rewrite old answer evidence or any other row');
 await db.query(await fs.readFile(path.join(migrations,resetMigration),'utf8'));
 // Apply the later cap only after these historical pre-cap transition assertions.
 await db.query(await fs.readFile(path.join(root,'supabase/migrations',capMigration),'utf8'));
 await db.query(await fs.readFile(path.join(root,'supabase/tests/challenge_levels_verify.sql'),'utf8'));checks++;
 console.log('Challenge ten-combo PostgreSQL checks passed:',checks);
}
run().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
 await Promise.allSettled([db?.end(),other?.end()]);
 if(created&&admin)await admin.query('DROP DATABASE "'+dbName+'" WITH (FORCE)');
 await admin?.end();
});
