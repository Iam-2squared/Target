'use strict';
// Synthetic wallets only. NEVER point this test at production.
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs/promises');
const path=require('node:path');
const {Client}=require('pg');
const root=path.resolve(__dirname,'..');
const uid=()=>crypto.randomUUID(),secret=crypto.randomBytes(40).toString('hex');
const database='target_quiz_hp_battle_'+process.pid+'_'+crypto.randomBytes(4).toString('hex')+'_test';
let admin,db,created=false,checks=0;
const eq=(x,y,msg)=>{checks++;assert.deepEqual(x,y,msg);};
const ok=(x,msg)=>{checks++;assert(x,msg);};
const actor=name=>({memberId:uid(),name,sessionHash:crypto.randomBytes(32).toString('hex')});
const host=actor('Battle Host'),guest=actor('Battle Guest');
async function rpc(member,action,params={},id=uid(),key=secret){
  const input={...member,...params};
  if(!['lobby','state','next'].includes(action))input.requestId=id;
  return (await db.query('SELECT public.target_battle_rpc($1,$2,$3::jsonb) x',[key,action,JSON.stringify(input)])).rows[0].x;
}
async function profile(p){return(await db.query('SELECT total_points,spent_points,casino_net FROM target_private.profiles WHERE member_id=$1',[p.memberId])).rows[0];}
async function wallet(p){return(await db.query('SELECT target_private.games_wallet($1) x',[p.memberId])).rows[0].x;}
async function events(id){return(await db.query('SELECT member_id,phase,kind,delta FROM target_private.battle_wallet_events WHERE match_id=$1 ORDER BY member_id,phase',[id])).rows;}
async function reconcile(){
  const mismatches=await db.query('SELECT count(*)::int n FROM target_private.profiles p JOIN target_private.wallet_finance_projection(NULL) r USING(member_id) WHERE (p.total_points,p.spent_points,p.casino_net) IS DISTINCT FROM(r.total_points,r.spent_points,r.casino_net)');
  eq(mismatches.rows[0].n,0,'consolidated income and immutable ledger reconcile');
  const imbalance=await db.query("SELECT count(*)::int n FROM target_private.battle_matches m LEFT JOIN LATERAL(SELECT coalesce(sum(e.delta),0) balance FROM target_private.battle_wallet_events e WHERE e.match_id=m.id) x ON true WHERE x.balance+m.escrow<>0");
  eq(imbalance.rows[0].n,0,'pot conservation');
}
async function adjust(p,amount){
  const batch={version:1,reason:'Disposable Target quiz battle ledger test',targets:[{memberId:p.memberId,expectedName:p.name,totalIncome:amount}]};
  await db.query('SELECT target_private.adjust_wallet_income($1,$2::jsonb)',
    ['income_adjust_battle_'+crypto.randomBytes(8).toString('hex'),JSON.stringify(batch)]);
}
async function main(){
  eq(process.env.NODE_ENV,'test','no production test mode');
  const url=new URL(process.env.DATABASE_URL||'');
  ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname)&&!url.search&&!url.hash,'only local PostgreSQL');
  const owner=new URL(url);owner.pathname='/postgres';
  admin=new Client({connectionString:owner.href});await admin.connect();
  await admin.query('CREATE DATABASE "'+database+'"');created=true;
  url.pathname='/'+database;db=new Client({connectionString:url.href});await db.connect();
  await db.query("DO $roles$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF; END $roles$");
  for(const name of (await fs.readdir(path.join(root,'supabase/migrations'))).filter(x=>/^[0-9]+_.*\.sql$/.test(x)).sort()){
    await db.query(await fs.readFile(path.join(root,'supabase/migrations',name),'utf8'));
  }
  await db.query("INSERT INTO target_private.server_credentials(singleton,key_hash) VALUES(true,encode(sha256(convert_to($1,'UTF8')),'hex'))",[secret]);
  for(const p of [host,guest]){
    await db.query('INSERT INTO target_private.profiles(member_id,name) VALUES($1,$2)',[p.memberId,p.name]);
    await adjust(p,10000);
  }
  eq((await rpc(host,'lobby',{},uid(),'wrong')).error.code,'RPC_FORBIDDEN','reject wrong credential before state writes');
  ok((await rpc(host,'lobby')).ok);
  const list=await rpc(guest,'lobby');
  ok(list.online.some(u=>u.id===host.memberId),'host shows online to guest');
  eq(list.ranking,[],'ranking stays empty before real completed battles');
  eq((await rpc(host,'lobby')).ranking,[],'no fabricated victories for signed-in host');
  const settings={book:'target1900',fromSection:1,toSection:1,stake:100,initialHp:100};
  let match=(await rpc(host,'challenge',{targetId:guest.memberId,...settings})).match;
  ok(match.id,'challenge creates a private room');
  eq(match.status,'invited');eq((await wallet(host)).balance,10000,'invite is free');
  eq((await rpc(guest,'lobby')).incoming.length,1,'guest sees invitation');
  match=(await rpc(guest,'accept',{matchId:match.id})).match;
  eq(match.status,'setup');eq((await events(match.id)).length,0,'accepted, no reserve until both approve');
  const updated={book:'target1900',fromSection:1,toSection:1,stake:200,initialHp:50};
  match=(await rpc(guest,'propose',{matchId:match.id,expectedVersion:match.offerVersion,...updated})).match;
  eq(match.offerVersion,2);eq(match.host.ready,false);eq(match.guest.ready,false);
  match=(await rpc(host,'ready',{matchId:match.id,expectedVersion:2})).match;
  eq(match.status,'setup');eq(match.pot,400);eq((await wallet(host)).balance,10000);
  const readyId=uid();
  const funded=await rpc(guest,'ready',{matchId:match.id,expectedVersion:2},readyId);
  match=funded.match;eq(match.status,'playing');eq(match.pot,400);
  eq((await wallet(host)).balance,9800);eq((await wallet(guest)).balance,9800);
  eq((await rpc(guest,'ready',{matchId:match.id,expectedVersion:2},readyId)).replayed,true);
  eq((await events(match.id)).length,2,'retry does not double-reserve');
  await reconcile();
  const choices=Array.from({length:4},(_,i)=>({id:uid(),text:['正解','不正解1','不正解2','不正解3'][i]}));
  const question={id:uid(),number:1,prompt:'合成データのテスト問題',choices,
    correctChoiceId:choices[0].id,correctText:choices[0].text};
  const next=(await rpc(host,'next',{matchId:match.id,question})).match;
  eq(next.question.id,question.id);
  ok(!Object.hasOwn(next.question,'correctChoiceId')&&!Object.hasOwn(next.question,'correctText'),
    'grading answers stay on server');
  const answerId=uid();
  let result=await rpc(host,'answer',{matchId:match.id,questionId:question.id,choiceId:choices[0].id},answerId);
  eq(result.answer.correct,true);eq(result.match.guest.hp,45,'correct: rival -5');
  eq((await rpc(host,'answer',{matchId:match.id,questionId:question.id,choiceId:choices[0].id},answerId)).replayed,true);
  const q2={...question,id:uid(),choices:choices.map(c=>({...c,id:uid()}))};
  q2.correctChoiceId=q2.choices[0].id;q2.correctText=q2.choices[0].text;
  await rpc(guest,'next',{matchId:match.id,question:q2});
  result=await rpc(guest,'answer',{matchId:match.id,questionId:q2.id,choiceId:q2.choices[1].id});
  eq(result.answer.correct,false);eq(result.match.guest.hp,35,'wrong: own -10');
  result=await rpc(guest,'cancel',{matchId:match.id});
  eq(result.match.status,'finished');eq(result.match.winner,'host','forfeit awards rival');
  eq((await wallet(host)).balance,10200,'winner receives two deposits, net +200');
  eq((await wallet(guest)).balance,9800,'loser already paid exactly one deposit');
  const completed=await rpc(host,'lobby');
  eq(completed.ranking.length,2,'winner and defeated participant both appear after a finished match');
  eq(completed.ranking.map(p=>[p.id,p.wins,p.rank]),[[host.memberId,1,1],[guest.memberId,0,2]],
    'ranking uses completed HP battle wins, never points or own wallet');
  eq((await rpc(guest,'lobby')).ranking.map(p=>p.wins),[1,0],
    'all logged-in users see the same battle ranking');
  eq((await rpc(host,'lobby')).ranking[0].wins,1,
    'repeated ranking fetches cannot award a second victory');
  await reconcile();
  const oldEvents=await events(match.id);eq(oldEvents.length,4,'two reserves and two settlements');
  await assert.rejects(db.query('UPDATE target_private.battle_wallet_events SET delta=0 WHERE match_id=$1',[match.id]),
    /permanent evidence/i);
  for(const role of ['anon','authenticated','service_role']){
    ok(!(await db.query("SELECT has_table_privilege($1,'target_private.battle_matches','SELECT') x",[role])).rows[0].x,
      'private match table inaccessible');
  }
  console.log(JSON.stringify({battle:'passed',checks,hostedWrites:false}));
}
main().catch(e=>{console.error(e.stack||e);process.exitCode=1;}).finally(async()=>{
  if(db)await db.end();
  if(admin){if(created)await admin.query('DROP DATABASE "'+database+'"');await admin.end();}
});
