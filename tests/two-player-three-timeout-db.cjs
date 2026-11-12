'use strict';
// Local, isolated real-PostgreSQL soccer timeout/finance integration test.
// Never connects to a hosted DB and never alters user profiles.
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs/promises');
const path=require('node:path');
const {Client}=require('pg');
const root=path.resolve(__dirname,'..');
const uuid=()=>crypto.randomUUID();
const secret=crypto.randomBytes(32).toString('base64url');
const databaseName='soccer_forfeit_'+process.pid;
let admin,db,created=false,checks=0;
const eq=(a,b,msg)=>{checks++;assert.deepEqual(a,b,msg);};
const ok=(value,msg)=>{checks++;assert.ok(value,msg);};
const people=[{id:uuid(),name:'LocalHost'},{id:uuid(),name:'LocalGuest'}];
async function rpc(actor,action,params={}){
  const payload={memberId:actor.id,name:actor.name,...params};
  if(!['wallet','state','expire','list'].includes(action))payload.requestId=uuid();
  const result=(await db.query('SELECT public.two_player_rpc($1,$2,$3::jsonb) AS value',
    [secret,action,JSON.stringify(payload)])).rows[0].value;
  if(result?.error)throw new Error('Soccer '+action+': '+JSON.stringify(result.error));
  return result;
}
async function row(id){
 return (await db.query('SELECT * FROM target_private.two_player_matches WHERE id=$1',[id])).rows[0];
}
function actor(match){
 const memberId=match[match.turn].memberId;
 const found=people.find(p=>p.id===memberId);
 ok(found,'known match participant');return found;
}
async function seed(p){
 await db.query('INSERT INTO target_private.profiles(member_id,name) VALUES($1,$2)',[p.id,p.name]);
 const quiz=uuid(),q=uuid(),c=uuid(),req=uuid();
 await db.query("INSERT INTO target_private.quizzes(id,member_id,request_id,book,direction,from_number,to_number,questions,total,answered_count,correct_count,quiz_points,charged_bytes) VALUES($1,$2,$3,'target1900','english',1,1,$4::jsonb,1,1,1,10000,512)",
 [quiz,p.id,uuid(),JSON.stringify([{id:q,number:1,correctChoiceId:c}])]);
 await db.query('INSERT INTO target_private.answers(quiz_id,member_id,question_id,choice_id,request_id,request_ids,response,award_points,charged_bytes) VALUES($1,$2,$3,$4,$5,ARRAY[$5::uuid],$6::jsonb,10000,512)',
 [quiz,p.id,q,c,req,JSON.stringify({correct:true,awardPoints:10000})]);
 await db.query('UPDATE target_private.profiles SET total_points=10000,correct_count=1,answered_count=1 WHERE member_id=$1',[p.id]);
}
async function start(){
 let r=await rpc(people[0],'create',{stake:100});const id=r.match.id;
 await rpc(people[1],'join',{code:r.match.code});
 await rpc(people[0],'ready',{matchId:id,ready:true});
 r=await rpc(people[1],'ready',{matchId:id,ready:true});
 eq(r.match.status,'playing','funded');
 eq(r.match.pot,200,'both stakes reserved');
 return r.match;
}
async function shot(matchId){
 const m=await rpc(people[0],'state',{matchId});
 const current=m.match;
 const player=actor(current);
 const r=await rpc(player,'input',{matchId,round:current.round,version:2,piece:0,angle:0,power:0});
 ok(r._processing,'accepted input carries an internal server lease');
 const result=await rpc(player,'resolve',{matchId,round:current.round,version:2,
  claimToken:r._processing.claimToken,goal:null,state:current.state,frames:[current.state]});
 eq(result.match.round,current.round+1,'real shot advances exactly once');
 return result.match;
}
async function miss(id){
 await db.query("UPDATE target_private.two_player_matches SET turn_started_at=clock_timestamp()-interval '61 seconds',turn_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[id]);
 await db.query('SELECT target_private.two_player_advance_turn(NULL,100)');
 return row(id);
}
async function cancel(id){
 await rpc(people[0],'cancel',{matchId:id});
 await rpc(people[1],'cancel',{matchId:id});
 eq((await row(id)).status,'cancelled','mutual cancellation remains available');
}
async function ranks(){
 return (await db.query('SELECT public.two_player_ranking_rpc($1,$2,$3::jsonb) AS result',
   [secret,'list',JSON.stringify({memberId:people[0].id,name:people[0].name})])).rows[0].result;
}
async function balances(){
 return Promise.all(people.map(async p=>(await rpc(p,'wallet')).wallet.balance));
}
async function main(){
 eq(process.env.NODE_ENV,'test','only local NODE_ENV=test permitted');
 const url=new URL(process.env.DATABASE_URL||'');
 ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname)&&!url.search&&!url.hash,
  'refuse remote connection strings');
 const aurl=new URL(url);aurl.pathname='/postgres';
 admin=new Client({connectionString:aurl.href});await admin.connect();
 await admin.query('CREATE DATABASE "'+databaseName+'"');created=true;
 url.pathname='/'+databaseName;db=new Client({connectionString:url.href});await db.connect();
 await db.query("DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF; IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; END $$");
 const dir=path.join(root,'supabase/migrations');
 for(const file of (await fs.readdir(dir)).filter(f=>/^[0-9]+_.*\.sql$/.test(f)).sort()){
   await db.query(await fs.readFile(path.join(dir,file),'utf8'));
 }
 await db.query("INSERT INTO target_private.two_player_credentials(singleton,key_hash) VALUES(true,encode(sha256(convert_to($1,'UTF8')),'hex'))",[secret]);
 for(const p of people)await seed(p);
 // A shot from the other player between misses qualifies the forfeiture.
 let m=await start();const loserSeat=m.turn,winnerSeat=loserSeat==='host'?'guest':'host';
 const loser=m[loserSeat].memberId,winner=m[winnerSeat].memberId;
 for(let i=1;i<=3;i++){
   const next=await miss(m.id);
   if(i<3){
     eq(next.status,'playing','no premature loss');
     eq(next[loserSeat+'_timeout_streak'],i,'count only that player');
     const a=await shot(m.id);
     eq(a[loserSeat].memberId,loser);
   }
 }
 const final=await row(m.id);
 eq(final.status,'finished','three misses are terminal');
 eq(final.reason,'three_timeouts','cause is explicit');
 eq(final.winner,winnerSeat,'other player wins');
 eq(final[loserSeat+'_timeout_streak'],3,'final streak retained');
 eq([final.host_score,final.guest_score],[0,0],'never forge goals');
 eq(final.escrow,0,'funding released');
 const endBalances=await balances();
 eq(endBalances[people.findIndex(p=>p.id===loser)],9900,'loser loses only their original stake');
 eq(endBalances[people.findIndex(p=>p.id===winner)],10100,'winner gets exact two-player pot');
 const before=await db.query('SELECT * FROM target_private.two_player_wallet_events WHERE match_id=$1',[m.id]);
 eq(before.rowCount,4,'one reserve and one settlement per participant');
 await db.query('SELECT target_private.two_player_advance_turn(NULL,100)');
 eq((await row(m.id)).winner,winnerSeat,'timeout retry never settles again');
 const afterward=await db.query('SELECT * FROM target_private.two_player_wallet_events WHERE match_id=$1',[m.id]);
 eq(afterward.rowCount,4,'no duplicate payout');
 let ranking=await ranks();
 ok(ranking.ok,'ranking is available');
 const winRow=ranking.ranking.find(x=>x.name===people.find(p=>p.id===winner).name);
 eq(winRow?.wins,1,'a forfeit counts as one victory');
 eq(winRow?.points,1,'a forfeit awards one point, not a fabricated three-goal result');
 ok(!ranking.ranking.some(x=>x.name===people.find(p=>p.id===loser).name),'loss has no negative points');

 // An accepted input resets *only its own* miss streak.
 m=await start();
 const side=m.turn;const other=side==='host'?'guest':'host';
 let next=await miss(m.id);
 eq(next[side+'_timeout_streak'],1);
 await shot(m.id); // opponent keeps game active
 await shot(m.id); // the originally absent player now takes a real shot
 let afterShot=await row(m.id);
 eq(afterShot[side+'_timeout_streak'],0,'valid accepted shot clears their prior misses');
 next=await miss(m.id); // other player now misses, for a separate counter
 eq(next[other+'_timeout_streak'],1,'separate player counters');
 eq(next.status,'playing');
 await cancel(m.id);

 // Unattended games are not arbitrarily awarded to either absent person.
 m=await start();
 await db.query("UPDATE target_private.two_player_matches SET turn_started_at=clock_timestamp()-interval '8 minutes',turn_expires_at=clock_timestamp()-interval '7 minutes' WHERE id=$1",[m.id]);
 await db.query('SELECT target_private.two_player_advance_turn(NULL,100)');
 let idle=await row(m.id);
 eq(idle.status,'playing','two idle sides cannot earn payouts');
 eq(idle.host_timeout_streak,3);
 eq(idle.guest_timeout_streak,3);
 await db.query("UPDATE target_private.two_player_matches SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[m.id]);
 await rpc(people[0],'state',{matchId:m.id});
 eq((await row(m.id)).status,'cancelled','ten-minute idle policy still refunds');
 eq(await balances(),endBalances,'both-idle encounter never changes wallets');

 // Pending accepted shots are not timed out while server physics is processing.
 m=await start();
 const active=actor(m);
 const accepted=await rpc(active,'input',{matchId:m.id,round:m.round,version:2,piece:0,angle:0,power:0});
 ok(accepted._processing,'pending shot');
 await db.query("UPDATE target_private.two_player_matches SET turn_started_at=clock_timestamp()-interval '61 seconds',turn_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[m.id]);
 await db.query('SELECT target_private.two_player_advance_turn(NULL,100)');
 const pending=await row(m.id);
 eq(pending.round,m.round,'pending shot not skipped');
 eq(pending.host_timeout_streak+pending.guest_timeout_streak,0,'no false timeout after accepted input');
 const completed=await rpc(active,'resolve',{matchId:m.id,round:m.round,version:2,claimToken:accepted._processing.claimToken,goal:null,state:m.state,frames:[m.state]});
 eq(completed.match.status,'playing');
 await cancel(m.id);

 // Historical three-goal scores keep their 3/2/1 point ranking unchanged.
 m=await start();
 await db.query('UPDATE target_private.two_player_matches SET host_score=3 WHERE id=$1',[m.id]);
 await db.query("SELECT target_private.two_player_settle($1,'finished','host','three_goals')",[m.id]);
 ranking=await ranks();
 const host=ranking.ranking.find(x=>x.name===people[0].name);
 eq(host?.points,(winner===people[0].id?1:0)+3,'3-0 keeps the three-point award');
 ok(!ranking.ranking.some(x=>x.points<0),'loss never deducts points');

 // In-flight financial and quota ledgers still reconcile after all scenarios.
 const imbalance=(await db.query("SELECT count(*)::integer AS count FROM target_private.two_player_matches m WHERE m.escrow+(SELECT coalesce(sum(e.delta),0) FROM target_private.two_player_wallet_events e WHERE e.match_id=m.id)<>0")).rows[0].count;
 eq(imbalance,0,'all reserved and released balances reconcile');
 console.log(JSON.stringify({threeTimeoutForfeit:'passed',checks,hostedWrites:false}));
}
main().catch(e=>{console.error(e.stack||e);process.exitCode=1;}).finally(async()=>{
 if(db)await db.end();
 if(admin){
   if(created)await admin.query('DROP DATABASE "'+databaseName+'"');
   await admin.end();
 }
});
