'use strict';
// All integrations run in an isolated loopback PostgreSQL database.
const crypto=require('node:crypto');
const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
const {Client}=require('pg');
const uuid=()=>crypto.randomUUID();
const root=path.resolve(__dirname,'..');
const secret=crypto.randomBytes(32).toString('base64url');
const name='soccer_social_'+process.pid;
let admin,db,created=false,checks=0;
const eq=(a,b,why)=>{checks++;assert.deepEqual(a,b,why);};
const ok=(a,why)=>{checks++;assert.ok(a,why);};
const people=[{id:uuid(),name:'Host'},{id:uuid(),name:'Guest'},{id:uuid(),name:'Spectator'}];
async function social(p,action,body={},auth=secret){
 const input={memberId:p.id,name:p.name,...body};
 return (await db.query('SELECT public.two_player_social_rpc($1,$2,$3::jsonb) AS value',
    [auth,action,JSON.stringify(input)])).rows[0].value;
}
async function game(p,action,body={}){
 const input={memberId:p.id,name:p.name,...body};
 if(!['wallet','state','list','expire'].includes(action))input.requestId=uuid();
 const result=(await db.query('SELECT public.two_player_rpc($1,$2,$3::jsonb) AS value',
   [secret,action,JSON.stringify(input)])).rows[0].value;
 if(result.error)throw new Error(action+': '+JSON.stringify(result.error));
 return result;
}
async function seed(p){
 await db.query('INSERT INTO target_private.profiles(member_id,name) VALUES($1,$2)',[p.id,p.name]);
 const quiz=uuid(),q=uuid(),choice=uuid(),req=uuid();
 await db.query("INSERT INTO target_private.quizzes(id,member_id,request_id,book,direction,from_number,to_number,questions,total,answered_count,correct_count,quiz_points,charged_bytes) VALUES($1,$2,$3,'target1900','english',1,1,$4::jsonb,1,1,1,10000,512)",
 [quiz,p.id,uuid(),JSON.stringify([{id:q,number:1,correctChoiceId:choice}])]);
 await db.query('INSERT INTO target_private.answers(quiz_id,member_id,question_id,choice_id,request_id,request_ids,response,award_points,charged_bytes) VALUES($1,$2,$3,$4,$5,ARRAY[$5::uuid],$6::jsonb,10000,512)',
 [quiz,p.id,q,choice,req,JSON.stringify({correct:true,awardPoints:10000})]);
 await db.query('UPDATE target_private.profiles SET total_points=10000,correct_count=1,answered_count=1 WHERE member_id=$1',[p.id]);
}
async function start(){
 let r=await game(people[0],'create',{stake:100});
 const id=r.match.id;
 await game(people[1],'join',{code:r.match.code});
 await game(people[0],'ready',{matchId:id,ready:true});
 r=await game(people[1],'ready',{matchId:id,ready:true});
 eq(r.match.status,'playing');return id;
}
async function balances(){
 return Promise.all(people.map(async p=>(await game(p,'wallet')).wallet.balance));
}
async function main(){
 eq(process.env.NODE_ENV,'test','only ephemeral local fixtures');
 const local=new URL(process.env.DATABASE_URL||'');
 ok(['127.0.0.1','localhost','[::1]'].includes(local.hostname)&&!local.search&&!local.hash,'remote hosts refused');
 const adminUrl=new URL(local);adminUrl.pathname='/postgres';admin=new Client({connectionString:adminUrl.href});await admin.connect();
 await admin.query('CREATE DATABASE "'+name+'"');created=true;
 local.pathname='/'+name;db=new Client({connectionString:local.href});await db.connect();
 await db.query("DO $roles$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF; IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF; END $roles$");
 const migrations=path.join(root,'supabase/migrations');
 for(const file of (await fs.readdir(migrations)).filter(n=>/^\d+_.*\.sql$/.test(n)).sort()){
   await db.query(await fs.readFile(path.join(migrations,file),'utf8'));
 }
 await db.query("INSERT INTO target_private.two_player_credentials(singleton,key_hash) VALUES(true,encode(sha256(convert_to($1,'UTF8')),'hex'))",[secret]);
 for(const p of people)await seed(p);
 const id=await start();
 const initial=await balances();eq(initial,[9900,9900,10000]);
 const financial=(await db.query('SELECT count(*)::integer AS n FROM target_private.two_player_wallet_events')).rows[0].n;
 const badSecret=await social(people[2],'list',{},'untrusted-secret');
 eq(badSecret.error.code,'RPC_FORBIDDEN');
 const games=await social(people[2],'list');
 eq(games.games.length,1);
 eq(games.games[0].id,id);
 ok(!JSON.stringify(games).includes('code'),'match code never listed');
 ok(!JSON.stringify(games).includes(people[0].id),'private member ids not listed');
 const blocked=await social(people[0],'watch',{matchId:id,afterRound:0});
 eq(blocked.error.code,'SPECTATOR_FORBIDDEN','players cannot join spectator mode');
 const watch=await social(people[2],'watch',{matchId:id,afterRound:0});
 ok(watch.ok,'verified member can spectate');
 eq(watch.match.status,'playing');
 eq(watch.match.host.name,people[0].name);
 eq(watch.match.guest.name,people[1].name);
 eq(watch.match.state.players.length,16);
 eq(watch.match.lastRound,null);
 ok(!JSON.stringify(watch).includes('claimToken'),'no private processing claims');
 ok(!JSON.stringify(watch).includes('"code"'),'no match room code');
 ok(!JSON.stringify(watch).includes('"stake"'),'no stakes in spectator view');
 ok(!JSON.stringify(watch).includes('"wallet"'),'no wallet info in spectate view');
 const presence=await social(people[0],'feed',{matchId:id});
 eq(presence.social.viewers,[people[2].name]);
 const unauthStamp=await social(people[2],'stamp',{matchId:id,stampId:2});
 eq(unauthStamp.error.code,'NOT_PARTICIPANT');
 for(const stampId of [0,9,'1','<b>Custom</b>']){
  const invalid=await social(people[0],'stamp',{matchId:id,stampId});
  eq(invalid.error.code,'INVALID_REQUEST','only eight fixed stamp codes');
 }
 const first=await social(people[0],'stamp',{matchId:id,stampId:1});
 ok(first.ok,'player sends approved stamp');
 eq(first.stamp.stampId,1);
 eq(first.stamp.fromName,people[0].name);
 const next=await social(people[0],'stamp',{matchId:id,stampId:2});
 eq(next.error.code,'STAMP_RATE_LIMIT','spam blocked within 5 seconds');
 const feed=await social(people[1],'feed',{matchId:id});
 eq(feed.social.stamp.id,first.stamp.id);
 eq(feed.social.stamp.stampId,1);
 eq(feed.social.viewers,[people[2].name]);
 const seen=await social(people[2],'watch',{matchId:id,afterRound:0});
 eq(seen.social.stamp.id,first.stamp.id);
 for(const stampId of [6,7,8]){
   // Fast-forward the sender cooldown in this isolated fixture; production
   // enforces the same five-second gap.
   await db.query("UPDATE target_private.two_player_social_stamps SET sent_at=clock_timestamp()-interval '6 seconds' WHERE match_id=$1 AND actor=$2",[id,people[0].id]);
   const receipt=await social(people[0],'stamp',{matchId:seen.match.id,stampId:stampId});
   ok(receipt.ok,'extended fixed stamp ID '+stampId+' is authorized');
   eq(receipt.stamp.stampId,stampId,'saved approved stamp ID');
   eq((await social(people[1],'feed',{matchId:seen.match.id} )).social.stamp.stampId,stampId,'opponent sees newest text stamp');
 }
 
 eq((await social(people[2],'stamp',{matchId:id,stampId:1})).error.code,'NOT_PARTICIPANT');
 const invalidAction=await social(people[2],'resolve',{matchId:id});
 eq(invalidAction.error.code,'INVALID_REQUEST');
 eq(await balances(),initial,'social use never changes wallets');
 eq((await db.query('SELECT count(*)::integer AS n FROM target_private.two_player_wallet_events')).rows[0].n,financial,
    'social never records financial events');
 const removed=await social(people[2],'leave',{matchId:id});
 ok(removed.ok);
 eq((await social(people[0],'feed',{matchId:id})).social.viewers,[]);
 await social(people[2],'watch',{matchId:id,afterRound:0});
 await db.query("UPDATE target_private.two_player_social_viewers SET seen_at=clock_timestamp()-interval '1 minute' WHERE match_id=$1",[id]);
 await db.query("UPDATE target_private.two_player_social_stamps SET sent_at=clock_timestamp()-interval '11 minutes' WHERE match_id=$1",[id]);
 await db.query('SELECT target_private.two_player_social_cleanup()');
 eq((await social(people[0],'feed',{matchId:id})).social.viewers,[]);
 eq((await social(people[0],'feed',{matchId:id})).social.stamp,null);
 eq((await db.query('SELECT count(*)::integer AS n FROM target_private.two_player_social_stamps')).rows[0].n,0,'stamps are ephemeral');
 eq((await db.query('SELECT count(*)::integer AS n FROM target_private.two_player_social_viewers')).rows[0].n,0,'viewers expire');
 for(const role of ['anon','authenticated','service_role']){
  ok(!(await db.query("SELECT has_table_privilege($1,'target_private.two_player_social_viewers','SELECT') AS permitted",[role])).rows[0].permitted,
      'private presence remains private');
  ok(!(await db.query("SELECT has_table_privilege($1,'target_private.two_player_social_stamps','SELECT') AS permitted",[role])).rows[0].permitted,
      'private stamps remain private');
 }
 await game(people[0],'cancel',{matchId:id});
 await game(people[1],'cancel',{matchId:id});
 eq((await social(people[2],'watch',{matchId:id,afterRound:0})).error.code,'MATCH_NOT_FOUND');
 eq((await social(people[2],'list')).games,[]);
 eq(await balances(),[10000,10000,10000],'funds returned after cancellation');
 console.log(JSON.stringify({soccerSocial:'passed',checks,hostedWrites:false}));
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1;}).finally(async()=>{
 if(db)await db.end();
 if(admin){if(created)await admin.query('DROP DATABASE "'+name+'"');await admin.end();}
});
