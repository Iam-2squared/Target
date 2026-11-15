'use strict';
// Authorized reset regression: synthetic users in a disposable loopback DB only.
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs/promises');
const path=require('node:path');
const {Client}=require('pg');
const {questionBlock}=require('../server/challenge.cjs');
const root=path.resolve(__dirname,'..');
const migrationName='20261115150438_target_challenge_progress_reset_and_late_level_pace.sql';
const uid=()=>crypto.randomUUID(),secret=crypto.randomBytes(40).toString('hex');
const dbName='target_progress_reset_'+process.pid+'_'+crypto.randomBytes(4).toString('hex')+'_test';
const actor=name=>({memberId:uid(),name,sessionHash:crypto.randomBytes(32).toString('hex')});
const paid=actor('Old Progress'),fx=actor('Old Special Pause'),playing=actor('Old Playing'),lost=actor('Old Defeat'),aborted=actor('Old Aborted');
const actors=[paid,fx,playing,lost,aborted],newIntervals=[3000,3000,3000,3000,3000,2800,2600,2400,2200,2000];
let admin,db,other,created=false,checks=0,afterReset=false,lastInput;
const eq=(a,b,label)=>{checks++;assert.deepEqual(a,b,label);};
const ok=(v,label)=>{checks++;assert(v,label);};
async function rpc(who,action,params={},client=db){
 const input={...who,...params};
 if(['start','answer','pause','resume','abort'].includes(action)&&!input.requestId)input.requestId=uid();
 return(await client.query('SELECT public.target_challenge_rpc($1,$2,$3::jsonb) x',[secret,action,JSON.stringify(input)])).rows[0].x;
}
async function row(id){return(await db.query('SELECT to_jsonb(r) x FROM target_private.challenge_runs r WHERE id=$1',[id])).rows[0].x;}
async function profile(who){return(await db.query('SELECT to_jsonb(p) x FROM target_private.profiles p WHERE member_id=$1',[who.memberId])).rows[0].x;}
async function wallet(who){return(await db.query('SELECT target_private.games_wallet($1) x',[who.memberId])).rows[0].x;}
async function put(who,run){
 if(run.status==='playing'&&!run.question){const value=await rpc(who,'next',{runId:run.id,questions:questionBlock(run.level)});ok(value.ok,JSON.stringify(value));return value.run;}
 return run;
}
async function start(who,level=1,requestId=uid()){
 const value=await rpc(who,'start',{requestId,level});ok(value.ok,JSON.stringify(value));return value.run;
}
async function answer(who,run,correct=true,requestId=uid()){
 run=await put(who,run);const q=(await row(run.id)).questions[0];assert(q);
 await db.query("UPDATE target_private.challenge_runs SET next_attack_at=clock_timestamp()+$2::integer*interval '1 millisecond' WHERE id=$1",[run.id,afterReset?newIntervals[run.level-1]:3000]);
 lastInput={requestId,runId:run.id,questionId:q.id,choiceId:correct?q.correctChoiceId:q.choices.find(c=>c.id!==q.correctChoiceId).id};
 const value=await rpc(who,'answer',lastInput);ok(value.ok,JSON.stringify(value));return value;
}
async function quickWin(who,level){
 let run=await start(who,level);run=await put(who,run);
 await db.query('UPDATE target_private.challenge_runs SET enemy_hp=5 WHERE id=$1',[run.id]);
 const value=await answer(who,run);eq(value.run.status,'won');eq(value.reward,level*100000);return value;
}
async function rows(table){assert(/^[a-z0-9_]+$/.test(table));return(await db.query('SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),\'[]\'::jsonb) x FROM target_private.'+table+' t')).rows[0].x;}
async function tables(){
 const names=(await db.query("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='target_private' AND c.relkind='r' ORDER BY c.relname")).rows;
 const hashes={};for(const {relname}of names){hashes[relname]=crypto.createHash('sha256').update(JSON.stringify(await rows(relname))).digest('hex');}return hashes;
}
async function functionHashes(){return(await db.query("SELECT jsonb_object_agg(proname,md5(prosrc)) x FROM pg_proc WHERE oid IN ('public.target_challenge_rpc(text,text,jsonb)'::regprocedure,'target_private.challenge_dto(uuid,uuid)'::regprocedure,'target_private.challenge_tick(uuid,timestamptz)'::regprocedure,'target_private.challenge_storage_charge()'::regprocedure,'target_private.wallet_finance_projection(timestamptz)'::regprocedure)")).rows[0].x;}
async function protections(){return(await db.query("SELECT jsonb_object_agg(tgname,tgenabled::text) x FROM pg_trigger WHERE NOT tgisinternal AND ((tgrelid='target_private.challenge_badges'::regclass AND tgname IN ('challenge_badges_immutable','challenge_badges_storage')) OR (tgrelid='target_private.challenge_requests'::regclass AND tgname='challenge_requests_immutable') OR (tgrelid='target_private.challenge_reward_events'::regclass AND tgname='challenge_rewards_immutable'))")).rows[0].x;}
async function logical(){return BigInt((await db.query('SELECT logical_bytes x FROM target_private.system_state WHERE singleton')).rows[0].x);}
async function charge(table,ids){assert(/^[a-z0-9_]+$/.test(table));return BigInt((await db.query('SELECT coalesce(sum(pg_column_size(to_jsonb(t))+128),0)::bigint x FROM target_private.'+table+' t'+(ids?' WHERE id=ANY($1::uuid[])':''),ids?[ids]:[])).rows[0].x);}
async function reconcile(){eq((await db.query('SELECT count(*)::int n FROM target_private.profiles p JOIN target_private.wallet_finance_projection(NULL) f USING(member_id) WHERE (p.total_points,p.spent_points,p.casino_net) IS DISTINCT FROM (f.total_points,f.spent_points,f.casino_net)')).rows[0].n,0,'all monetary caches reconcile with immutable financial history');}
async function main(){
 eq(process.env.NODE_ENV,'test');const url=new URL(process.env.DATABASE_URL||'');
 ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&!url.search&&!url.hash,'fresh loopback fixture only');
 const owner=new URL(url);owner.pathname='/postgres';admin=new Client({connectionString:owner.href});await admin.connect();
 await admin.query('CREATE DATABASE "'+dbName+'"');created=true;url.pathname='/'+dbName;
 db=new Client({connectionString:url.href});other=new Client({connectionString:url.href});await db.connect();await other.connect();
 await db.query("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF; END $$");
 const dir=path.join(root,'supabase/migrations');for(const file of(await fs.readdir(dir)).filter(f=>/^\d+_.*\.sql$/.test(f)&&f!==migrationName).sort())await db.query(await fs.readFile(path.join(dir,file),'utf8'));
 const migration=await fs.readFile(path.join(dir,migrationName),'utf8');
 await db.query("INSERT INTO target_private.server_credentials(singleton,key_hash) VALUES(true,encode(sha256(convert_to($1,'UTF8')),'hex'))",[secret]);
 for(const who of actors)await db.query('INSERT INTO target_private.profiles(member_id,name) VALUES($1,$2)',[who.memberId,who.name]);
 let oldWin,oldWinningInput,oldStartingInput;
 for(let level=1;level<=10;level++){
  const requestId=uid();let run=await start(paid,level,requestId);run=await put(paid,run);
  await db.query('UPDATE target_private.challenge_runs SET enemy_hp=5 WHERE id=$1',[run.id]);
  oldWin=await answer(paid,run);eq(oldWin.run.status,'won');eq(oldWin.badgeAwarded,true);
  if(level===10){oldWinningInput={...lastInput};oldStartingInput={requestId,level};}
 }
 eq((await wallet(paid)).totalIncome,5500000);
 const paidActive=await put(paid,await start(paid,10));
 await quickWin(fx,1);let fxRun=await put(fx,await start(fx,1));
 await db.query('UPDATE target_private.challenge_runs SET streak=9,correct_count=9,player_hp=90 WHERE id=$1',[fxRun.id]);
 const special=await answer(fx,fxRun);eq(special.answer.specialPaused,true);eq(special.run.status,'paused');
 const specialInput={...lastInput},autoResumeId=uid(),autoResume={requestId:autoResumeId,runId:fxRun.id,specialRequestId:specialInput.requestId};
 eq((await rpc(fx,'resume',autoResume)).run.status,'playing');
 const manualPauseId=uid();fxRun=(await rpc(fx,'pause',{requestId:manualPauseId,runId:fxRun.id})).run;eq(fxRun.status,'paused');
 let playingRun=await put(playing,await start(playing));const wrong=await answer(playing,playingRun,false);playingRun=wrong.run;const oldWrongInput={...lastInput};
 let lostRun=await put(lost,await start(lost));await db.query('UPDATE target_private.challenge_runs SET player_hp=10 WHERE id=$1',[lostRun.id]);const oldLost=await answer(lost,lostRun,false);lostRun=oldLost.run;eq(lostRun.status,'lost');ok(lostRun.mistakes.length===1);
 const abortedRun=(await rpc(aborted,'abort',{runId:(await start(aborted)).id})).run;eq(abortedRun.status,'aborted');
 const preMap=await rpc(paid,'map');eq(preMap.levels.filter(l=>l.cleared).length,10);ok(preMap.clearerCandidates.length>=11);
 await reconcile();
 const failureBefore=await tables(),functionsBefore=await functionHashes();
 await db.query("CREATE FUNCTION target_private.reset_failure_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='target_private.challenge_badges'::regclass AND tgname='challenge_badges_immutable' AND tgenabled='D') OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='target_private.challenge_badges'::regclass AND tgname='challenge_badges_storage' AND tgenabled='O') OR EXISTS(SELECT 1 FROM target_private.challenge_badges) THEN RAISE EXCEPTION 'Reset fixture did not reach deleted badges with only immutable guard disabled'; END IF; RAISE EXCEPTION 'forced reset rollback after badge delete' USING ERRCODE='54000'; END $$; CREATE TRIGGER zz_reset_failure_fixture AFTER DELETE ON target_private.challenge_badges FOR EACH ROW EXECUTE FUNCTION target_private.reset_failure_fixture()");
 await assert.rejects(()=>db.query(migration),error=>error.code==='54000'&&/forced reset rollback after badge delete/.test(error.message));checks++;
 await db.query('ROLLBACK');eq(await tables(),failureBefore,'failed reset rolls back badge deletion, aborted runs and all quota changes');eq(await functionHashes(),functionsBefore,'failed reset rolls back all three patched function definitions');
 for(const state of Object.values(await protections()))eq(state,'O','all immutable/storage guards are enabled after rollback');
 await db.query('DROP TRIGGER zz_reset_failure_fixture ON target_private.challenge_badges; DROP FUNCTION target_private.reset_failure_fixture()');
 await assert.rejects(()=>db.query('DELETE FROM target_private.challenge_badges WHERE member_id=$1 AND level=1',[paid.memberId]),{code:'42501'});checks++;
 const before=await tables(),oldRuns=await rows('challenge_runs'),activeIds=oldRuns.filter(r=>['playing','paused'].includes(r.status)).map(r=>r.id);
 const priorWallets=new Map();for(const who of actors)priorWallets.set(who.memberId,await wallet(who));
 const activeBytes=await charge('challenge_runs',activeIds),badgeBytes=await charge('challenge_badges'),budget=await logical();
 const systemBefore=(await rows('system_state'))[0],financeSource=(await db.query("SELECT prosrc FROM pg_proc WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure")).rows[0].prosrc;
 await db.query(migration);afterReset=true;
 const after=await tables();
 for(const name of Object.keys(before).filter(n=>!['challenge_runs','challenge_badges','system_state'].includes(n)))eq(after[name],before[name],'reset preserves every non-progress table: '+name);
 const newRuns=new Map((await rows('challenge_runs')).map(r=>[r.id,r]));
 for(const original of oldRuns){const current=newRuns.get(original.id);if(['playing','paused'].includes(original.status)){
   const stable=r=>{const{status,questions,next_attack_at,updated_at,...rest}=r;return rest;};
   eq(stable(current),stable(original),'active HP/streak/counters/reward flags remain exact');eq(current.status,'aborted');eq(current.questions,[]);eq(current.next_attack_at,null);ok(Date.parse(current.updated_at)>=Date.parse(original.updated_at));
  }else eq(current,original,'won/lost/already-aborted history remains byte-for-byte exact');}
 eq(await rows('challenge_badges'),[]);eq(await logical()-budget,(await charge('challenge_runs',activeIds))-activeBytes-badgeBytes,'quota releases exactly deleted badges and cleared active question data');
 const systemAfter=(await rows('system_state'))[0];eq({...systemAfter,logical_bytes:systemBefore.logical_bytes},systemBefore);
 eq((await db.query("SELECT prosrc FROM pg_proc WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure")).rows[0].prosrc,financeSource);
 const hashes=await functionHashes();eq(hashes.target_challenge_rpc,'6bcffc66c8f4cf01aab57219ff140aae');eq(hashes.challenge_dto,'d0fdbe59478a7ebc3b479dc854090e29');eq(hashes.challenge_tick,'a81f2b827c4146ada04e2240a49cfc52');eq(hashes.challenge_storage_charge,'71d4ba2553f5ef56ca0ebc65063f42d9');eq(hashes.wallet_finance_projection,'bd93399757a066fdfb8f35e7e29af2dc');
 for(const state of Object.values(await protections()))eq(state,'O');
 await db.query(await fs.readFile(path.join(root,'supabase/tests/challenge_progress_reset_once_verify.sql'),'utf8'));checks++;
 for(const who of actors){const map=await rpc(who,'map');eq(map.activeRun,null);eq(map.clearerCandidates,[]);eq(map.levels.map(r=>r.cleared),Array(10).fill(false));eq(map.levels.map(r=>r.unlocked),[true,...Array(9).fill(false)]);eq(map.levels.map(r=>r.attackIntervalMs),newIntervals);eq(await wallet(who),priorWallets.get(who.memberId),'earned money survives reset');}
 const countBefore=(await rows('challenge_runs')).length,rewardsBefore=(await rows('challenge_reward_events')).length;
 const oldPaidReplay=await rpc(paid,'answer',oldWinningInput);eq(oldPaidReplay.replayed,true);eq(oldPaidReplay.run.status,'won');eq(oldPaidReplay.run.badgeAwarded,true,'historical badge-awarded fact is preserved');eq(oldPaidReplay.wallet,priorWallets.get(paid.memberId));
 const oldStartReplay=await rpc(paid,'start',oldStartingInput);eq(oldStartReplay.replayed,true);eq(oldStartReplay.run.id,oldWin.run.id);eq((await rows('challenge_runs')).length,countBefore);eq((await rows('challenge_reward_events')).length,rewardsBefore);eq(await rows('challenge_badges'),[],'old paid/start UUIDs cannot restore cleared progress');
 for(let level=2;level<=10;level++)eq((await rpc(paid,'start',{level})).error.code,'CHALLENGE_LOCKED');
 eq((await rpc(fx,'resume',{runId:fxRun.id,specialRequestId:specialInput.requestId})).error.code,'CHALLENGE_SPECIAL_CHANGED');
 const oldResumeReplay=await rpc(fx,'resume',autoResume);eq(oldResumeReplay.replayed,true);eq(oldResumeReplay.run.status,'aborted');
 eq((await rpc(fx,'resume',{runId:fxRun.id})).run.status,'aborted');eq((await rpc(fx,'pause',{requestId:manualPauseId,runId:fxRun.id})).run.status,'aborted');
 eq((await rpc(playing,'answer',oldWrongInput)).run.status,'aborted');eq((await rpc(playing,'state',{runId:playingRun.id})).run.question,null);
 eq((await rpc(lost,'state',{runId:lostRun.id})).run.mistakes,oldLost.run.mistakes,'historical defeat review survives progress reset');
 await reconcile();
 let current=await start(paid,1);eq(current.playerHp,100);eq(current.enemyHp,100);eq(current.streak,0);eq(current.correctCount,0);eq(current.wrongCount,0);eq(current.questionSequence,0);eq(current.question,null);
 const initialIncome=(await wallet(paid)).totalIncome;
 for(let level=1;level<=10;level++){
  if(level>1)current=await start(paid,level);
  const pace=newIntervals[level-1],maxHp=100+50*(level-1),damage=level===10?15:5+(level-1);
  eq(current.attackIntervalMs,pace);eq(current.nextAttackInMs,pace);eq((await row(current.id)).attack_remaining_ms,pace);
  current=await put(paid,current);ok(current.nextAttackInMs<=pace&&current.nextAttackInMs>pace-200);
  const questionId=current.question.id;
  await db.query("UPDATE target_private.challenge_runs SET next_attack_at=clock_timestamp()-$2::integer*interval '1 millisecond' WHERE id=$1",[current.id,2*pace+100]);
  current=(await rpc(paid,'state',{runId:current.id})).run;eq(current.playerHp,maxHp-3*damage,'server tick uses exact tier interval');ok(current.nextAttackInMs<=pace&&current.nextAttackInMs>pace-300);
  current=(await rpc(paid,'pause',{runId:current.id})).run;const fraction=current.nextAttackInMs,hp=current.playerHp;eq(current.question,null);
  await db.query('SELECT pg_sleep(0.01)');const paused=(await rpc(paid,'state',{runId:current.id})).run;eq(paused.nextAttackInMs,fraction);eq(paused.playerHp,hp);
  current=(await rpc(paid,'resume',{runId:current.id})).run;eq(current.question.id,questionId);eq(current.playerHp,hp);eq(current.attackIntervalMs,pace);ok(current.nextAttackInMs<=fraction&&current.nextAttackInMs>fraction-100);
  await db.query('UPDATE target_private.challenge_runs SET streak=9,correct_count=9 WHERE id=$1',[current.id]);
  const special=await answer(paid,current);eq(special.run.status,'paused');eq(special.run.question,null);eq(special.answer.specialPaused,true);eq(special.answer.specialPercent,10);eq(special.answer.specialPower,10*level);eq(special.answer.specialDamage,10*level);
  const source={...lastInput},specialRow=await row(current.id);eq(specialRow.next_attack_at,null);ok(specialRow.attack_remaining_ms<=pace&&specialRow.attack_remaining_ms>pace-200);
  const nextQuestion=specialRow.questions[0].id;
  current=(await rpc(paid,'resume',{requestId:uid(),runId:current.id,specialRequestId:source.requestId})).run;
  eq(current.status,'playing');eq(current.attackIntervalMs,pace);eq(current.question.id,nextQuestion);ok(current.nextAttackInMs<=specialRow.attack_remaining_ms&&current.nextAttackInMs>specialRow.attack_remaining_ms-100);
  await db.query('UPDATE target_private.challenge_runs SET enemy_hp=5 WHERE id=$1',[current.id]);
  const won=await answer(paid,current);eq(won.run.status,'won');eq(won.reward,level*100000);eq(won.badgeAwarded,true);
  const freshInput={...lastInput};const replays=await Promise.all([rpc(paid,'answer',freshInput),rpc(paid,'answer',freshInput,other)]);
  for(const replay of replays){eq(replay.replayed,true);eq(replay.wallet,won.wallet);eq(replay.run.status,'won');}
  eq((await db.query('SELECT count(*)::int n FROM target_private.challenge_badges WHERE member_id=$1 AND level=$2',[paid.memberId,level])).rows[0].n,1);
  if(level===1){const map=await rpc(paid,'map');eq(map.levels.map(r=>r.unlocked),[true,true,...Array(8).fill(false)]);eq(map.levels.filter(r=>r.cleared).map(r=>r.level),[1]);
   const historical=await rpc(paid,'answer',oldWinningInput);eq(historical.replayed,true);eq((await rows('challenge_badges')).length,1);eq((await rpc(paid,'start',{level:3})).error.code,'CHALLENGE_LOCKED','old level-ten receipt cannot bypass the fresh level-one progression');
   await assert.rejects(()=>db.query('DELETE FROM target_private.challenge_badges WHERE member_id=$1',[paid.memberId]),{code:'42501'});checks++;
  }
 }
 eq((await wallet(paid)).totalIncome,initialIncome+5500000);eq((await rows('challenge_badges')).length,10);await reconcile();
 await db.query(await fs.readFile(path.join(root,'supabase/tests/challenge_levels_verify.sql'),'utf8'));checks++;
 // The ordinary verifier accepts legitimate new progress; the one-time empty
 // postflight is deliberately not a permanent invariant after play resumes.
 console.log('Challenge progress-reset PostgreSQL checks passed:',checks);
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await Promise.allSettled([db?.end(),other?.end()]);if(created&&admin)await admin.query('DROP DATABASE "'+dbName+'" WITH (FORCE)');await admin?.end();});
