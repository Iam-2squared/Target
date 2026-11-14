'use strict';
// Loopback-only migration and authoritative gameplay regression; no hosted writes.
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs/promises'),path=require('node:path');
const {Client}=require('pg');
const root=path.resolve(__dirname,'..'),migration='20261109235530_target_two_player_turn_clock.sql';
const physics=require(path.join(process.env.TWO_PLAYER_SOURCE_ROOT||path.resolve(root,'../2player'),'public/physics.js'));
const name='two_player_clock_'+process.pid+'_test',secret=crypto.randomBytes(32).toString('base64url'),uuid=()=>crypto.randomUUID();
let admin,db,created=false,checks=0;
function eq(a,b,label){checks++;assert.deepEqual(a,b,label)} function ok(a,label){checks++;assert.ok(a,label)}
async function rpc(actor,action,body={},requestId=uuid()){
 const input={memberId:actor.id,name:actor.name,...body}; if(!['state','wallet','list','expire'].includes(action))input.requestId=requestId;
 return (await db.query('SELECT public.two_player_rpc($1,$2,$3::jsonb) AS value',[secret,action,JSON.stringify(input)])).rows[0].value;
}
async function row(id){return(await db.query('SELECT * FROM target_private.two_player_matches WHERE id=$1',[id])).rows[0]}
async function seed(p){
 await db.query('INSERT INTO target_private.profiles(member_id,name) VALUES($1,$2)',[p.id,p.name]);
 const quiz=uuid(),q=uuid(),c=uuid(),request=uuid();
 await db.query("INSERT INTO target_private.quizzes(id,member_id,request_id,book,direction,from_number,to_number,questions,total,answered_count,correct_count,quiz_points,charged_bytes) VALUES($1,$2,$3,'target1900','english',1,1,$4::jsonb,1,1,1,10000,512)",[quiz,p.id,uuid(),JSON.stringify([{id:q,number:1,correctChoiceId:c}])]);
 await db.query('INSERT INTO target_private.answers(quiz_id,member_id,question_id,choice_id,request_id,request_ids,response,award_points,charged_bytes) VALUES($1,$2,$3,$4,$5,ARRAY[$5::uuid],$6::jsonb,10000,512)',[quiz,p.id,q,c,request,JSON.stringify({correct:true,awardPoints:10000})]);
 await db.query('UPDATE target_private.profiles SET total_points=10000,correct_count=1,answered_count=1 WHERE member_id=$1',[p.id]);
}
async function start(a,b){let r=await rpc(a,'create',{stake:100});const id=r.match.id;await rpc(b,'join',{code:r.match.code});await rpc(a,'ready',{matchId:id,ready:true});r=await rpc(b,'ready',{matchId:id,ready:true});eq(r.match.status,'playing');return r.match}
function actorFor(match,players){return players.find(p=>p.id===match[match.turn].memberId)}
async function accept(match,players){const actor=actorFor(match,players),r=await rpc(actor,'input',{matchId:match.id,round:match.round,version:2,piece:0,angle:0,power:0});ok(r._processing,'shot has a recoverable lease');return{actor,claim:r._processing}}
function resultBody(match,claim,state,frames=[state],goal=null){return{matchId:match.id,round:claim.round,version:2,claimToken:claim.claimToken,state,frames,goal}}
async function setClock(id,expiredSeconds){await db.query("WITH c AS MATERIALIZED(SELECT clock_timestamp()-$2*interval '1 second' AS deadline) UPDATE target_private.two_player_matches SET turn_started_at=c.deadline-interval '60 seconds',turn_expires_at=c.deadline FROM c WHERE id=$1",[id,expiredSeconds])}
async function main(){
 eq(process.env.NODE_ENV,'test');const url=new URL(process.env.DATABASE_URL||'');ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname)&&!url.search&&!url.hash,'must use loopback');
 const aurl=new URL(url);aurl.pathname='/postgres';admin=new Client({connectionString:aurl.href});await admin.connect();await admin.query('CREATE DATABASE "'+name+'"');created=true;url.pathname='/'+name;db=new Client({connectionString:url.href});await db.connect();
 await db.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; END $$");
 const dir=path.join(root,'supabase/migrations');for(const file of(await fs.readdir(dir)).filter(f=>/^\d+_.*sql$/.test(f)&&f<migration).sort())await db.query(await fs.readFile(path.join(dir,file),'utf8'));
 await db.query("INSERT INTO target_private.two_player_credentials(singleton,key_hash) VALUES(true,encode(sha256(convert_to($1,'UTF8')),'hex'))",[secret]);
 const players=[{id:uuid(),name:'fixtureA'},{id:uuid(),name:'fixtureB'}];for(const p of players)await seed(p);
 const financeBefore=(await db.query("SELECT prosrc FROM pg_proc WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure")).rows[0].prosrc;
 let match=await start(...players);let pending=await accept(match,players);const legacyActor=pending.actor;let legacyBody=resultBody(match,pending.claim,match.state),legacyId=uuid();
 let resolved=await rpc(pending.actor,'resolve',legacyBody,legacyId);eq(resolved.match.round,2);
 const oldResult=(await db.query('SELECT to_jsonb(x) AS value FROM target_private.two_player_moves x WHERE match_id=$1 AND round=1',[match.id])).rows[0].value;
 match=resolved.match;pending=await accept(match,players);const pendingBefore=(await row(match.id)).state;
 const moneyBefore=(await db.query('SELECT jsonb_agg(to_jsonb(e) ORDER BY member_id,phase) AS value FROM target_private.two_player_wallet_events e')).rows[0].value;
 await db.query(await fs.readFile(path.join(dir,migration),'utf8'));
 eq((await db.query("SELECT prosrc FROM pg_proc WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure")).rows[0].prosrc,financeBefore,'financial projection unchanged');
 eq((await row(match.id)).state,pendingBefore,'accepted pending shot starting state preserved at cutover');
 eq((await db.query('SELECT jsonb_agg(to_jsonb(e) ORDER BY member_id,phase) AS value FROM target_private.two_player_wallet_events e')).rows[0].value,moneyBefore,'escrow receipts untouched');
 const afterOld=(await db.query("SELECT to_jsonb(x)-'turn_rules' AS value FROM target_private.two_player_moves x WHERE match_id=$1 AND round=1",[match.id])).rows[0].value;
 eq(afterOld,oldResult,'historical resolved row is unchanged except new default marker');
 eq((await rpc(legacyActor,'resolve',legacyBody,legacyId)).ok,true,'same old request replays');
 eq((await rpc(legacyActor,'resolve',legacyBody)).ok,true,'historical result hash accepts another idempotent claim request');
 const cachedBody=resultBody(match,pending.claim,pendingBefore),cachedId=uuid();
 resolved=await rpc(pending.actor,'resolve',cachedBody,cachedId);eq(resolved.ok,true,'cached server pending result canonicalized');match=resolved.match;
 eq(match.state,physics.clearGoalAreas(pendingBefore));
 const newResult=(await db.query('SELECT state,frames,turn_rules FROM target_private.two_player_moves WHERE match_id=$1 AND round=2',[match.id])).rows[0];
 eq(newResult.turn_rules,true);eq(newResult.state,match.state);eq(newResult.frames.at(-1),match.state,'stored last frame equals clean next-turn state');
 eq((await rpc(pending.actor,'resolve',cachedBody)).ok,true,'canonicalized cached result replays with new request ID');
 const initial=(await db.query('SELECT target_private.two_player_initial_state($1,$1) AS state',[match.host.formation])).rows[0].state;eq(initial,physics.initialState([match.host.formation,match.host.formation]));
 // Timeouts are atomic passive state transitions and do not renew abandonment.
 let before=await row(match.id);await setClock(match.id,1);const expired=await row(match.id);
 let next=await rpc(players[0],'state',{matchId:match.id});eq(next.match.round,before.round+1);ok(next.match.turn!==before.turn);eq((await row(match.id)).expires_at,expired.expires_at);
 ok(Math.abs(Date.parse(next.match.turnExpiresAt)-expired.turn_expires_at.getTime()-60000)<2,'uses exact previous deadline boundary');
 eq((await rpc(players[1],'state',{matchId:match.id})).match.round,next.match.round,'repeat observer cannot pass twice');
 eq((await rpc(actorFor(match,players),'input',{matchId:match.id,round:match.round,version:2,piece:0,angle:0,power:0})).error.code,'STALE_INPUT');
 match=next.match;await setClock(match.id,61);next=await rpc(players[0],'state',{matchId:match.id});eq(next.match.round,match.round+2);eq(next.match.turn,match.turn,'two elapsed turns preserve parity');match=next.match;
 // A timely accepted input is not forfeited while server computation is leased.
 pending=await accept(match,players);await setClock(match.id,1);next=await rpc(players[0],'state',{matchId:match.id});eq(next.match.round,match.round,'accepted pending move survives deadline');
 const frames=Array.from({length:121},()=>match.state);resolved=await rpc(pending.actor,'resolve',resultBody(match,pending.claim,match.state,frames));eq(resolved.ok,true);match=resolved.match;
 ok(Date.parse(match.turnStartedAt)-Date.parse(match.serverNow)>5800,'playback grace precedes full minute');eq(Date.parse(match.turnExpiresAt)-Date.parse(match.turnStartedAt),60000);
 eq((await rpc(actorFor(match,players),'input',{matchId:match.id,round:match.round,version:2,piece:0,angle:0,power:0})).error.code,'TURN_PENDING','cannot shoot before playback ends');
 await assert.rejects(db.query('UPDATE target_private.two_player_matches SET turn_expires_at=NULL WHERE id=$1',[match.id]),e=>e.code==='23514');checks++;
 const directInput=()=>db.query('INSERT INTO target_private.two_player_moves(match_id,round,version,actor,piece,angle,power) VALUES($1,$2,2,$3,0,0,0)',[match.id,match.round,match.turn]);
 await assert.rejects(directInput(),e=>e.code==='P7502');checks++;
 await setClock(match.id,1);await assert.rejects(directInput(),e=>e.code==='P7502');checks++;
 await setClock(match.id,-59); // open the following turn without waiting real time.
 // Force the real between-check-and-INSERT boundary race, without sleeping.
 const raceBefore=(await db.query('SELECT to_jsonb(m) AS value FROM target_private.two_player_matches m WHERE id=$1',[match.id])).rows[0].value;
 const chargeBefore=(await db.query('SELECT logical_bytes FROM target_private.system_state WHERE singleton')).rows[0].logical_bytes;
 await db.query("CREATE FUNCTION target_private.two_player_test_deadline_race() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN WITH c AS MATERIALIZED(SELECT clock_timestamp()-interval '1 millisecond' AS deadline) UPDATE target_private.two_player_matches SET turn_started_at=c.deadline-interval '60 seconds',turn_expires_at=c.deadline FROM c WHERE id=NEW.match_id; RETURN NEW; END $$; CREATE TRIGGER aa_test_deadline_race BEFORE INSERT ON target_private.two_player_moves FOR EACH ROW EXECUTE FUNCTION target_private.two_player_test_deadline_race()");
 const raced=await rpc(actorFor(match,players),'input',{matchId:match.id,round:match.round,version:2,piece:0,angle:0,power:0});eq(raced.error.code,'STALE_INPUT','deadline crossing returns typed conflict');
 await db.query('DROP TRIGGER aa_test_deadline_race ON target_private.two_player_moves;DROP FUNCTION target_private.two_player_test_deadline_race()');
 eq((await db.query('SELECT to_jsonb(m) AS value FROM target_private.two_player_matches m WHERE id=$1',[match.id])).rows[0].value,raceBefore,'racing input rolls all match changes back');
 eq((await db.query('SELECT logical_bytes FROM target_private.system_state WHERE singleton')).rows[0].logical_bytes,chargeBefore,'racing input rolls storage reservation back');
 await db.query('UPDATE target_private.two_player_matches SET round=300 WHERE id=$1',[match.id]);
 match=(await rpc(players[0],'state',{matchId:match.id})).match;eq(match.round,300,'counter crosses former40 limit');
 pending=await accept(match,players);resolved=await rpc(pending.actor,'resolve',resultBody(match,pending.claim,match.state));eq(resolved.match.round,301);eq(resolved.match.status,'playing');
 // Match cancellation/refunds remain exact with the same original reserve rows.
 await rpc(players[0],'cancel',{matchId:match.id});await rpc(players[1],'cancel',{matchId:match.id});
 for(const p of players)eq((await rpc(p,'wallet')).wallet.balance,10000);
 const counts=(await db.query("SELECT count(*) FILTER(WHERE phase='reserve')::int AS reserves,count(*) FILTER(WHERE phase='settle')::int AS settles,sum(delta)::int AS net FROM target_private.two_player_wallet_events")).rows[0];eq(counts,{reserves:2,settles:2,net:0});
 // Geometry parity uses fixtures generated by the actual JS module, not a copy.
 const fixtures=[];
 const add=(name,state)=>fixtures.push({name,state,expected:physics.clearGoalAreas(state)});
 for(let i=0;i<3;i++)add('initial'+i,physics.initialState([i,i]));
 const old=physics.initialState();old.players[0].y=900;old.players[8].y=60;add('old keepers',old);
 for(const y of [60,900]){const packed=physics.initialState();packed.players=Array.from({length:16},()=>({x:320,y}));add('packed'+y,packed);}
 const precise=physics.initialState();precise.players[0]={x:320,y:900};precise.ball={x:320.123456,y:846.765432};add('precise ball',precise);
 let rng=904193;const random=max=>{rng=(Math.imul(rng,1664525)+1013904223)>>>0;return rng%max;};
 for(let i=0;i<100;i++){
   const state={players:Array.from({length:16},()=>({x:28+random(584001)/1000,y:28+random(904001)/1000})),ball:{x:14+random(612001)/1000,y:14+random(932001)/1000}};
   add('random'+i,state);add('rotated'+i,{players:state.players.slice(8).concat(state.players.slice(0,8)).map(p=>({x:640-p.x,y:960-p.y})),ball:{x:640-state.ball.x,y:960-state.ball.y}});
 }
 for(const f of fixtures){const actual=(await db.query('SELECT target_private.two_player_clear_goal_areas($1::jsonb) AS value',[JSON.stringify(f.state)])).rows[0].value;eq(actual,f.expected,f.name+' SQL/JS parity');}
 // An entirely unattended game still expires and refunds, even after passes.
 match=await start(...players);await db.query("UPDATE target_private.two_player_matches SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[match.id]);
 eq((await rpc(players[0],'state',{matchId:match.id})).match.status,'cancelled');for(const p of players)eq((await rpc(p,'wallet')).wallet.balance,10000);
 for(const file of ['two_player_soccer_verify.sql','two_player_lobby_verify.sql','two_player_shared_formation_verify.sql','two_player_turn_clock_verify.sql']){
  const result=await db.query(await fs.readFile(path.join(root,'supabase/tests',file),'utf8'));
  ok(result.some(r=>r.rows?.some(row=>String(row.result||'').endsWith('_postflight_passed'))),file);
 }
 console.log(JSON.stringify({turnClockDb:'passed',checks,hostedWrites:false}));
}
main().catch(e=>{console.error(e.stack||e);process.exitCode=1}).finally(async()=>{if(db)await db.end();if(admin){if(created)await admin.query('DROP DATABASE "'+name+'"');await admin.end();}});
