'use strict';
// Disposable local PostgreSQL only. NEVER execute this test on Production.
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs/promises');
const path=require('node:path');
const {Client}=require('pg');
const root=path.resolve(__dirname,'..');
const uid=()=>crypto.randomUUID();
const secret=crypto.randomBytes(40).toString('hex');
const dbName='target_sprint_'+process.pid+'_'+crypto.randomBytes(4).toString('hex')+'_test';
const actor=name=>({memberId:uid(),name,sessionHash:crypto.randomBytes(32).toString('hex')});
const host=actor('Sprint Host'),guest=actor('Sprint Guest');
let admin,db,other,created=false,checks=0;
const eq=(a,b,msg)=>{checks++;assert.deepEqual(a,b,msg);};
const ok=(v,msg)=>{checks++;assert(v,msg);};
async function rpc(member,action,params={},requestId=uid(),client=db,key=secret){
  const input={...member,...params};
  if(!['lobby','state','next'].includes(action))input.requestId=requestId;
  return (await client.query('SELECT public.target_battle_rpc($1,$2,$3::jsonb) x',
     [key,action,JSON.stringify(input)])).rows[0].x;
}
async function sprint(member,action,params={},requestId=uid(),client=db,key=secret){
  const input={...member,...params};
  if(action==='answer')input.requestId=requestId;
  return (await client.query('SELECT public.target_sprint_rpc($1,$2,$3::jsonb) x',
     [key,action,JSON.stringify(input)])).rows[0].x;
}
async function wallet(member){
  return (await db.query('SELECT target_private.games_wallet($1) x',[member.memberId])).rows[0].x;
}
async function receipts(matchId){
  return (await db.query('SELECT member_id,phase,kind,delta FROM target_private.battle_wallet_events WHERE match_id=$1 ORDER BY member_id,phase',[matchId])).rows;
}
async function reconcile(){
  const delta=await db.query('SELECT count(*)::int n FROM target_private.profiles p JOIN target_private.wallet_finance_projection(NULL) f USING(member_id) WHERE (p.total_points,p.spent_points,p.casino_net) IS DISTINCT FROM (f.total_points,f.spent_points,f.casino_net)');
  eq(delta.rows[0].n,0,'disposable finance projection matches profiles');
  const conservation=await db.query("SELECT count(*)::int n FROM target_private.battle_matches m LEFT JOIN LATERAL (SELECT coalesce(sum(e.delta),0) net FROM target_private.battle_wallet_events e WHERE e.match_id=m.id) x ON true WHERE x.net + m.escrow <> 0");
  eq(conservation.rows[0].n,0,'stake receipts conserve total money + escrow');
}
async function adjust(member,amount){
 const batch={version:1,reason:'Synthetic Target sprint financial gate',targets:[{memberId:member.memberId,expectedName:member.name,totalIncome:amount}]};
 await db.query('SELECT target_private.adjust_wallet_income($1,$2::jsonb)',
   ['sprint_test_'+crypto.randomBytes(8).toString('hex'),JSON.stringify(batch)]);
}
function makeQuestion(number){
 const choices=Array.from({length:4},(_,i)=>({id:uid(),text:'意味'+number+'-'+i}));
 return {id:uid(),number,prompt:'english '+number,choices,
   correctChoiceId:choices[0].id,correctText:choices[0].text};
}
async function openMatch(stake=200,hp=100){
 await rpc(host,'lobby');await rpc(guest,'lobby');
 const defaults={book:'target1900',fromSection:1,toSection:1,stake:100,initialHp:100};
 let m=(await rpc(host,'challenge',{targetId:guest.memberId,...defaults})).match;
 ok(m?.id,'invitation creates a room');
 eq(m.status,'invited');eq((await receipts(m.id)).length,0,'invitation never reserves funds');
 m=(await rpc(guest,'accept',{matchId:m.id})).match;
 eq(m.status,'setup','after acceptance both can configure');
 m=(await rpc(host,'propose',{matchId:m.id,expectedVersion:m.offerVersion,
   book:'target1900',fromSection:1,toSection:1,stake,initialHp:hp})).match;
 eq(m.host.ready,false);eq(m.guest.ready,false);
 m=(await rpc(guest,'ready',{matchId:m.id,expectedVersion:m.offerVersion})).match;
 eq(m.status,'setup','one approval is insufficient');
 m=(await rpc(host,'ready',{matchId:m.id,expectedVersion:m.offerVersion})).match;
 eq(m.status,'playing');eq(m.pot,2*stake,'funded match escrows both deposits');
 return m;
}
async function putQuestion(member,matchId,question){
 return (await sprint(member,'next',{matchId,question})).match;
}
async function answer(member,matchId,q,correct=true,id=uid(),client=db){
 const choice=correct?q.choices[0].id:q.choices[1].id;
 return sprint(member,'answer',{matchId,questionId:q.id,choiceId:choice},id,client);
}
async function main(){
 eq(process.env.NODE_ENV,'test','never perform destructive fixture testing outside NODE_ENV=test');
 const url=new URL(process.env.DATABASE_URL||'');
 ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&!url.search&&!url.hash,
    'database must be localhost and no query overrides');
 const owner=new URL(url);owner.pathname='/postgres';
 admin=new Client({connectionString:owner.href});await admin.connect();
 await admin.query('CREATE DATABASE "'+dbName+'"');created=true;
 url.pathname='/'+dbName;db=new Client({connectionString:url.href});await db.connect();
 await db.query("DO $roles$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF; END $roles$");
 for(const name of (await fs.readdir(path.join(root,'supabase/migrations'))).filter(x=>/^[0-9]+_.*\.sql$/.test(x)).sort()){
   await db.query(await fs.readFile(path.join(root,'supabase/migrations',name),'utf8'));
 }
 await db.query("INSERT INTO target_private.server_credentials(singleton,key_hash) VALUES(true,encode(sha256(convert_to($1,'UTF8')),'hex'))",[secret]);
 for(const member of [host,guest]){
   await db.query('INSERT INTO target_private.profiles(member_id,name) VALUES($1,$2)',[member.memberId,member.name]);
   await adjust(member,10000);
 }
 eq((await sprint(host,'state',{matchId:uid()},uid(),db,'bad-secret')).error.code,'RPC_FORBIDDEN',
   'secret gate runs before reads or writes');
 ok((await rpc(host,'lobby')).ok);
 ok((await rpc(guest,'lobby')).online.some(x=>x.id===host.memberId),'presence is authenticated');
 const m=await openMatch(200,100);
 eq((await wallet(host)).balance,9800);eq((await wallet(guest)).balance,9800);
 await reconcile();

 const ha=makeQuestion(1),ga=makeQuestion(2);
 let hostM=(await sprint(host,'next',{matchId:m.id,question:ha})).match;
 let guestM=(await sprint(guest,'next',{matchId:m.id,question:ga})).match;
 eq(hostM.question.id,ha.id);eq(guestM.question.id,ga.id,
   'each player receives their own independent question');
 ok(!Object.hasOwn(hostM.question,'correctChoiceId')&&!Object.hasOwn(hostM.question,'correctText'),
   'private correct option remains server-side');
 eq((await sprint(host,'next',{matchId:m.id,question:makeQuestion(3)})).match.question.id,ha.id,
   'new-question polling cannot silently replace a pending question');
 eq((await sprint(host,'state',{matchId:m.id})).match.question.id,ha.id,'own question is stable');
 const missId=uid();let result=await answer(host,m.id,ha,false,missId);
 eq(result.answer.correct,false);eq(result.answer.damage,10);
 eq(result.match.host.hp,90);eq(result.match.guest.hp,100,'wrong answer damages only its owner');
 eq(result.match.host.streak,0);
 eq(result.match.events.at(-1).actorRole,'host');
 eq(result.match.events.at(-1).correct,false,'server publishes outcome, not the answer key');
 eq((await sprint(host,'answer',{matchId:m.id,questionId:ha.id,choiceId:ha.choices[1].id},missId)).replayed,true,
   'retry cannot apply self damage twice');
 eq((await sprint(host,'answer',{matchId:m.id,questionId:ha.id,choiceId:ha.choices[0].id})).error.code,
   'BATTLE_QUESTION_CHANGED','old question may not be answered a second time');
 eq((await sprint(guest,'state',{matchId:m.id})).match.question.id,ga.id,
   'opponent can continue their question independently');

 result=await answer(guest,m.id,ga,true);
 eq(result.answer.correct,true);eq(result.match.host.hp,85,'guest correct attacks host -5');
 eq(result.match.guest.streak,1);
 for(let i=0;i<5;i++){
   const q=makeQuestion(10+i);
   hostM=await putQuestion(host,m.id,q);
   eq(hostM.question.id,q.id,'host receives requested private question');
   const own=hostM.question;
   const correctId=q.correctChoiceId;
   result=await sprint(host,'answer',{matchId:m.id,questionId:own.id,choiceId:correctId});
   eq(result.answer.correct,true);
   eq(result.answer.damage,5);
   eq(result.match.guest.hp,95-5*i,'only the opponent takes the correct-hit damage');
   eq(result.match.host.streak,(i+1)%5);
   if(i===4){
     eq(result.answer.streakBonus,true,'fifth consecutive correct triggers healing');
     eq(result.answer.healedHp,10,'fifth correct heals ten HP');
     eq(result.match.host.hp,95,'healing restores 85 to 95 HP');
   }
 }
 for(let i=0;i<5;i++){
   const q=makeQuestion(20+i);
   hostM=await putQuestion(host,m.id,q);
   result=await answer(host,m.id,q,true);
   if(i===4){
     eq(result.answer.streakBonus,true,'tenth correct triggers a second recovery');
     eq(result.answer.healedHp,5,'healing is capped at initial HP');
     eq(result.match.host.hp,100,'HP cannot exceed initial HP');
   }
 }
 eq(result.match.guest.hp,50,'10 correct hits deal 50 total damage');
 eq(result.match.host.streak,0,'streak restarts after five consecutive successes');

 other=new Client({connectionString:url.href});await other.connect();
 const hq=makeQuestion(40),gq=makeQuestion(41);
 hostM=await putQuestion(host,m.id,hq);
 guestM=await putQuestion(guest,m.id,gq);
 eq(hostM.question.id,hq.id);
 eq(guestM.question.id,gq.id);
 const before=(await sprint(host,'state',{matchId:m.id})).match;
 const outcomes=await Promise.all([
   sprint(host,'answer',{matchId:m.id,questionId:hq.id,choiceId:hq.correctChoiceId},uid(),db),
   sprint(guest,'answer',{matchId:m.id,questionId:gq.id,choiceId:gq.correctChoiceId},uid(),other)
 ]);
 eq(outcomes.filter(x=>x.answer?.correct===true).length,2,
   'both players may score concurrently on different questions');
 const after=(await sprint(host,'state',{matchId:m.id})).match;
 eq(after.host.hp+after.guest.hp,before.host.hp+before.guest.hp-10,
    'two simultaneous answers each deal exactly five HP damage');
 eq((await sprint(host,'state',{matchId:m.id})).match.events.length>0,true);
 await reconcile();

 eq((await rpc(guest,'cancel',{matchId:m.id})).match.winner,'host','forfeit awards the opponent');
 eq((await wallet(host)).balance,10200);eq((await wallet(guest)).balance,9800);
 eq((await receipts(m.id)).length,4,'exactly two reserves and two settlements');
 await reconcile();

 const ko=await openMatch(100,100);
 await db.query('UPDATE target_private.battle_matches SET guest_hp=10 WHERE id=$1',[ko.id]);
 const knockout=makeQuestion(55);
 await sprint(guest,'next',{matchId:ko.id,question:knockout});
 const koResult=await answer(guest,ko.id,knockout,false);
 eq(koResult.answer.damage,10);eq(koResult.match.status,'finished');
 eq(koResult.match.winner,'host','wrong answer at 10 HP ends match immediately');
 eq((await receipts(ko.id)).length,4,'self-KO settles at most once');
 await reconcile();
 const invalid=await sprint(host,'answer',{matchId:ko.id,questionId:knockout.id,choiceId:knockout.correctChoiceId});
 eq(invalid.error.code,'BATTLE_NOT_PLAYING','ended match cannot accept new answers');

 for(const role of ['anon','authenticated','service_role']){
   ok(!(await db.query("SELECT has_table_privilege($1,'target_private.battle_current_questions','SELECT') x",[role])).rows[0].x,
     'correct options are inaccessible from client roles');
 }
 ok(! (await db.query("SELECT has_function_privilege('authenticated','public.target_sprint_rpc(text,text,jsonb)','EXECUTE') x")).rows[0].x,
   'authenticated users cannot bypass backend to call the server-only sprint RPC');
 const stamp=(await sprint(host,'state',{matchId:ko.id})).match.events.at(-1);
 ok(!Object.hasOwn(stamp,'correctChoiceId')&&!Object.hasOwn(stamp,'choiceId'),
    'event feed never leaks exact answers');
 console.log(JSON.stringify({sprint:'passed',checks,hostedWrites:false}));
}
main().catch(err=>{console.error(err.stack||err);process.exitCode=1;}).finally(async()=>{
 if(other)await other.end();
 if(db)await db.end();
 if(admin){if(created)await admin.query('DROP DATABASE "'+dbName+'"');await admin.end();}
});
