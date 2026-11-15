'use strict';
// Synthetic identities in a fresh loopback database. Never hosted data.
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs/promises'),path=require('node:path');
const {Client}=require('pg');
const {questionBlock}=require('../server/challenge.cjs');
const root=path.resolve(__dirname,'..'),migrationName='20261115144738_target_challenge_defeat_mistake_review.sql';
const resetMigration='20261115150438_target_challenge_progress_reset_and_late_level_pace.sql';
const uid=()=>crypto.randomUUID(),secret=crypto.randomBytes(40).toString('hex');
const dbName='target_review_'+process.pid+'_'+crypto.randomBytes(4).toString('hex')+'_test';
const actor=name=>({memberId:uid(),name,sessionHash:crypto.randomBytes(32).toString('hex')});
const owner=actor('Review Owner'),legacy=actor('Legacy Review'),otherMember=actor('Other Review'),winner=actor('Winning Review'),aborted=actor('Aborted Review'),long=actor('Unicode Review'),quota=actor('Quota Review'),fatal=actor('Fatal Review');
let admin,db,reload,created=false,checks=0,baseline=0n;
const eq=(a,b,label)=>{checks++;assert.deepEqual(a,b,label);},ok=(v,label)=>{checks++;assert(v,label);};
async function rpc(who,action,params={},client=db){const input={...who,...params};if(['start','answer','pause','resume','abort'].includes(action)&&!input.requestId)input.requestId=uid();return(await client.query('SELECT public.target_challenge_rpc($1,$2,$3::jsonb) x',[secret,action,JSON.stringify(input)])).rows[0].x;}
async function row(id){return(await db.query('SELECT to_jsonb(r) x FROM target_private.challenge_runs r WHERE id=$1',[id])).rows[0].x;}
function question(book,number,prompt,correctText){const choices=[correctText,'誤り一','誤り二','誤り三'].map(text=>({id:uid(),text}));return{id:uid(),book,number,prompt,correctText,correctChoiceId:choices[0].id,choices};}
function block(level,first=[]){const rest=questionBlock(level);for(const q of first){const i=rest.findIndex(r=>r.book===q.book);assert(i>=0);rest.splice(i,1);}return[...first,...rest];}
async function seed(who,level=1,hp=100+50*(level-1),first=[]){const id=(await db.query("INSERT INTO target_private.challenge_runs(member_id,level,player_hp,enemy_hp,attack_remaining_ms) VALUES($1,$2::integer,$3,$2::integer*100,3000) RETURNING id",[who.memberId,level,hp])).rows[0].id;const result=await rpc(who,'next',{runId:id,questions:block(level,first)});ok(result.ok,JSON.stringify(result));return result.run;}
function publicResponse(result){
 ok(!Object.hasOwn(result.answer||{},'mistake'),'private snapshot is never public answer metadata');
 const {answer,run,...rest}=result;ok(!JSON.stringify(rest).includes('correctText'));
 if(run){const {mistakes,...current}=run;ok(!JSON.stringify(current).includes('correctText'));ok(!JSON.stringify(current).includes('correctChoiceId'));
  if(run.status!=='lost')eq(mistakes||[],[],'ongoing, paused, winning and aborted runs have no review');}
}
async function hit(who,id,correct=false,requestId=uid()){
 const q=(await row(id)).questions[0];assert(q);
 await db.query("UPDATE target_private.challenge_runs SET next_attack_at=clock_timestamp()+interval '3 seconds' WHERE id=$1",[id]);
 const input={requestId,runId:id,questionId:q.id,choiceId:correct?q.correctChoiceId:q.choices[1].id};
 const result=await rpc(who,'answer',input);publicResponse(result);ok(result.ok,JSON.stringify(result));return{q,input,result};
}
const snapshotQuestion=q=>({book:q.book,number:q.number,prompt:q.prompt,correctText:q.correctText});
async function tables(){const names=(await db.query("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='target_private' AND c.relkind='r' ORDER BY c.relname")).rows;const data={};for(const {relname}of names){assert(/^[a-z0-9_]+$/.test(relname));data[relname]=(await db.query("SELECT md5(coalesce(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text),'')) h FROM target_private."+relname+' t')).rows[0].h;}return data;}
const chargesSql="SELECT coalesce(sum(n),0)::bigint bytes FROM (SELECT pg_column_size(to_jsonb(t))+128 n FROM target_private.challenge_runs t UNION ALL SELECT pg_column_size(to_jsonb(t))+128 FROM target_private.challenge_badges t UNION ALL SELECT pg_column_size(to_jsonb(t))+128 FROM target_private.challenge_reward_events t UNION ALL SELECT pg_column_size(to_jsonb(t))+128 FROM target_private.challenge_rates t UNION ALL SELECT pg_column_size(to_jsonb(t))+128+CASE WHEN action='answer' AND response#>>'{answer,correct}'='false' AND jsonb_typeof(response#>'{answer,mistake}')='object' THEN 128 ELSE 0 END FROM target_private.challenge_requests t) c";
async function logical(){return BigInt((await db.query('SELECT logical_bytes n FROM target_private.system_state WHERE singleton')).rows[0].n);}
async function accounting(){eq(await logical(),baseline+BigInt((await db.query(chargesSql)).rows[0].bytes),'quota includes exact retained rows and additional128 per partial-index entry');}
async function main(){
 eq(process.env.NODE_ENV,'test');const url=new URL(process.env.DATABASE_URL||'');ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&!url.search&&!url.hash,'fresh localhost only');
 const adminUrl=new URL(url);adminUrl.pathname='/postgres';admin=new Client({connectionString:adminUrl.href});await admin.connect();await admin.query('CREATE DATABASE "'+dbName+'"');created=true;
 url.pathname='/'+dbName;db=new Client({connectionString:url.href});reload=new Client({connectionString:url.href});await db.connect();await reload.connect();
 await db.query("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF; END $$");
 const dir=path.join(root,'supabase/migrations');for(const f of(await fs.readdir(dir)).filter(f=>/^\d+_.*\.sql$/.test(f)&&![migrationName,resetMigration].includes(f)).sort())await db.query(await fs.readFile(path.join(dir,f),'utf8'));
 await db.query("INSERT INTO target_private.server_credentials(singleton,key_hash) VALUES(true,encode(sha256(convert_to($1,'UTF8')),'hex'))",[secret]);
 for(const who of[owner,legacy,otherMember,winner,aborted,long,quota,fatal])await db.query('INSERT INTO target_private.profiles(member_id,name) VALUES($1,$2)',[who.memberId,who.name]);
 const oldRun=await seed(legacy,1,10,[question('target1900',9,'legacy word','昔の意味')]);const oldAnswer=await hit(legacy,oldRun.id);eq(oldAnswer.result.run.status,'lost');
 const oldReceipt=(await db.query('SELECT to_jsonb(q) x FROM target_private.challenge_requests q WHERE member_id=$1 AND request_id=$2',[legacy.memberId,oldAnswer.input.requestId])).rows[0].x;
 const before=await tables(),finance=(await db.query("SELECT prosrc FROM pg_proc WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure")).rows[0].prosrc;
 await db.query(await fs.readFile(path.join(dir,migrationName),'utf8'));
 eq(await tables(),before,'migration changes no historical rows, clocks, budget or wallet data');
 eq((await db.query("SELECT prosrc FROM pg_proc WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure")).rows[0].prosrc,finance);
 baseline=await logical()-BigInt((await db.query(chargesSql)).rows[0].bytes);
 const oldReload=await rpc(legacy,'state',{runId:oldRun.id},reload);eq(oldReload.run.mistakes,[],'old missing prompt evidence is never reconstructed');
 const oldReplay=await rpc(legacy,'answer',oldAnswer.input);publicResponse(oldReplay);eq(oldReplay.answer,oldAnswer.result.answer);
 eq((await db.query('SELECT to_jsonb(q) x FROM target_private.challenge_requests q WHERE member_id=$1 AND request_id=$2',[legacy.memberId,oldAnswer.input.requestId])).rows[0].x,oldReceipt);
 const word=question('target1900',12,'harbor','港'),idiom=question('target1000',3,'look after','世話をする'),kobun=question('kobun400',7,'あはれなり','しみじみと趣深い'),duplicate=question('target1900',12,'later harbor text','後から変更された意味'),correctOnly=question('target1900',44,'correct only','正解のみ');
 const run=await seed(owner,7,400,[word,idiom,kobun,duplicate,correctOnly]);publicResponse({run});
 const first=await hit(owner,run.id);eq((await row(run.id)).wrong_count,1);
 const receipt=(await db.query('SELECT response FROM target_private.challenge_requests WHERE member_id=$1 AND request_id=$2',[owner.memberId,first.input.requestId])).rows[0].response;
 eq(receipt.answer.mistake,snapshotQuestion(word),'private receipt stores the original graded prompt and meaning');
 publicResponse(await rpc(owner,'pause',{runId:run.id}));publicResponse(await rpc(owner,'state',{runId:run.id},reload));publicResponse(await rpc(owner,'resume',{runId:run.id}));
 await hit(owner,run.id);await hit(owner,run.id);await hit(owner,run.id);const right=await hit(owner,run.id,true);
 ok(!Object.hasOwn((await db.query('SELECT response FROM target_private.challenge_requests WHERE member_id=$1 AND request_id=$2',[owner.memberId,right.input.requestId])).rows[0].response.answer,'mistake'),'correct answers do not create review snapshots');
 await db.query("UPDATE target_private.challenge_runs SET player_hp=1,next_attack_at=clock_timestamp()-interval '1 millisecond' WHERE id=$1",[run.id]);
 const lost=await rpc(owner,'state',{runId:run.id});eq(lost.run.status,'lost');eq(lost.run.mistakes,[word,idiom,kobun].map(snapshotQuestion),'enemy-clock loss returns first-occurrence deduplicated wrong English and classical words');
 eq((await rpc(owner,'state',{runId:run.id},reload)).run.mistakes,lost.run.mistakes,'review survives a new connection/reload');
 const replay=await rpc(owner,'answer',first.input);publicResponse(replay);eq(replay.run.mistakes,lost.run.mistakes);eq(replay.replayed,true);
 eq((await rpc(otherMember,'state',{runId:run.id})).error.code,'CHALLENGE_NOT_FOUND');ok(!JSON.stringify(await rpc(otherMember,'map')).includes('harbor'),'another member map contains no private review');
 const fatalQ=question('target1900',12,'other member','別人の意味'),otherRun=await seed(otherMember,1,10,[fatalQ]);const fatalAnswer=await hit(otherMember,otherRun.id);
 eq(fatalAnswer.result.run.status,'lost');eq(fatalAnswer.result.run.mistakes,[snapshotQuestion(fatalQ)],'SAME fatal-wrong response includes its newly inserted final snapshot');
 const secondRun=(await rpc(owner,'start',{level:1})).run;await rpc(owner,'next',{runId:secondRun.id,questions:block(1,[question('target1900',20,'separate run','別の挑戦')])});await db.query('UPDATE target_private.challenge_runs SET player_hp=10 WHERE id=$1',[secondRun.id]);
 const second=await hit(owner,secondRun.id);eq(second.result.run.mistakes,[{book:'target1900',number:20,prompt:'separate run',correctText:'別の挑戦'}]);eq((await rpc(owner,'state',{runId:run.id})).run.mistakes,lost.run.mistakes,'each own run retains a separate review');
 const winRun=await seed(winner);await hit(winner,winRun.id);await db.query('UPDATE target_private.challenge_runs SET enemy_hp=5 WHERE id=$1',[winRun.id]);const win=await hit(winner,winRun.id,true);eq(win.result.run.status,'won');eq(win.result.run.mistakes,[]);publicResponse(await rpc(winner,'state',{runId:winRun.id}));
 const quitRun=await seed(aborted);await hit(aborted,quitRun.id);const quit=await rpc(aborted,'abort',{runId:quitRun.id});eq(quit.run.status,'aborted');eq(quit.run.mistakes,[]);
 // Invalid poison would fail a lost aggregation, proving the CASE does not run
 // that query at all for playing/paused/won/aborted DTOs. Roll back all fixtures.
 const beforePoison=await tables();await db.query('BEGIN');
 await db.query("INSERT INTO target_private.challenge_requests(member_id,request_id,action,payload_hash,run_id,response) VALUES($1,$2,'answer',repeat('0',64),$3,$4)",[winner.memberId,uid(),winRun.id,JSON.stringify({ok:true,answer:{correct:false,mistake:{book:'target1900',number:'bad',prompt:'not evaluated',correctText:'not evaluated'}}})]);
 for(const status of['won','aborted','paused','playing']){await db.query('UPDATE target_private.challenge_runs SET status=$2,next_attack_at=NULL WHERE id=$1',[winRun.id,status]);eq((await db.query('SELECT target_private.challenge_dto($1,$2) x',[winRun.id,winner.memberId])).rows[0].x.mistakes,[],'nonlost CASE skips review aggregation: '+status);}
 await db.query("UPDATE target_private.challenge_runs SET status='lost',player_hp=0 WHERE id=$1",[winRun.id]);await assert.rejects(()=>db.query('SELECT target_private.challenge_dto($1,$2)',[winRun.id,winner.memberId]),{code:'22P02'});checks++;await db.query('ROLLBACK');eq(await tables(),beforePoison);
 // Find an actual maximum-size accepted UTF-8 candidate and retain its long
 // snapshot; the previous4096-byte receipt limit would reject this wrong answer.
 const unicode=n=>Array.from({length:n},()=>String.fromCharCode(0x4e00+crypto.randomInt(0x4fff))).join('');
 const text=unicode(3000),longQ=question('kobun400',42,'',unicode(400));let lo=1,hi=3000,best=0,bestBytes=0;
 while(lo<=hi){const mid=Math.floor((lo+hi)/2);longQ.prompt=text.slice(0,mid);const size=(await db.query('SELECT pg_column_size($1::jsonb) n',[JSON.stringify(longQ)])).rows[0].n;if(size<=8192){best=mid;bestBytes=size;lo=mid+1;}else hi=mid-1;}
 longQ.prompt=text.slice(0,best);ok(bestBytes<=8192&&bestBytes>=8188,'candidate is at the accepted8KiB boundary');
 const longRun=await seed(long,7,10,[longQ]),longAnswer=await hit(long,longRun.id);eq(longAnswer.result.run.mistakes,[snapshotQuestion(longQ)]);
 const receiptBytes=(await db.query('SELECT pg_column_size(response) n FROM target_private.challenge_requests WHERE member_id=$1 AND request_id=$2',[long.memberId,longAnswer.input.requestId])).rows[0].n;ok(receiptBytes>4096&&receiptBytes<=16384,'valid Unicode wrong snapshot fits the guarded16KiB receipt limit');
 const qRun=await seed(quota,1,100,[question('target1900',2,'budget word','予算')]);const q=(await row(qRun.id)).questions[0],input={requestId:uid(),runId:qRun.id,questionId:q.id,choiceId:q.choices[1].id};
 const logicalBefore=await logical();await db.query('BEGIN');const measured=await rpc(quota,'answer',input);ok(measured.ok);const delta=await logical()-logicalBefore;await db.query('ROLLBACK');ok(delta>128n);
 const full=104857600n-delta+64n;await db.query('UPDATE target_private.system_state SET logical_bytes=$1 WHERE singleton',[full.toString()]);const beforeCapacity=await tables();
 eq((await rpc(quota,'answer',input)).error.code,'CAPACITY_LIMIT');eq(await tables(),beforeCapacity,'extra index reservation is atomic at the real shared quota boundary');
 await db.query('UPDATE target_private.system_state SET logical_bytes=$1 WHERE singleton',[logicalBefore.toString()]);ok((await rpc(quota,'answer',input)).ok);await accounting();
 const fRun=await seed(fatal,1,10,[question('target1900',8,'fatal atomic','致命の復習')]),fq=(await row(fRun.id)).questions[0],fi={requestId:uid(),runId:fRun.id,questionId:fq.id,choiceId:fq.choices[1].id};
 await db.query("CREATE FUNCTION target_private.review_capacity_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'late review receipt capacity' USING ERRCODE='54000'; END $$; CREATE TRIGGER zz_review_capacity_fixture AFTER INSERT ON target_private.challenge_requests FOR EACH ROW EXECUTE FUNCTION target_private.review_capacity_fixture()");
 const beforeFatal=await tables();eq((await rpc(fatal,'answer',fi)).error.code,'CAPACITY_LIMIT');eq(await tables(),beforeFatal,'fatal loss, final snapshot, review visibility and index accounting roll back together');
 await db.query('DROP TRIGGER zz_review_capacity_fixture ON target_private.challenge_requests; DROP FUNCTION target_private.review_capacity_fixture()');
 const retried=await rpc(fatal,'answer',fi);eq(retried.run.status,'lost');eq(retried.run.mistakes,[snapshotQuestion(fq)]);publicResponse(retried);await accounting();
 await db.query('SET enable_seqscan=off');const plan=await db.query("EXPLAIN (FORMAT JSON) SELECT response FROM target_private.challenge_requests WHERE run_id=$1 AND member_id=$2 AND action='answer' AND response#>>'{answer,correct}'='false' AND jsonb_typeof(response#>'{answer,mistake}')='object' ORDER BY created_at,request_id",[run.id,owner.memberId]);ok(JSON.stringify(plan.rows).includes('challenge_mistake_run'),'the selective lost-review query uses its partial run index');await db.query('RESET enable_seqscan');
 eq((await db.query('SELECT count(*)::int n FROM target_private.profiles p JOIN target_private.wallet_finance_projection(NULL) f USING(member_id) WHERE (p.total_points,p.spent_points,p.casino_net) IS DISTINCT FROM (f.total_points,f.spent_points,f.casino_net)')).rows[0].n,0);
 await db.query(await fs.readFile(path.join(dir,resetMigration),'utf8'));
 await db.query(await fs.readFile(path.join(root,'supabase/tests/challenge_levels_verify.sql'),'utf8'));checks++;
 console.log('Challenge defeat-review PostgreSQL checks passed:',checks,'candidateBytes='+bestBytes,'receiptBytes='+receiptBytes);
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{await Promise.allSettled([db?.end(),reload?.end()]);if(created&&admin)await admin.query('DROP DATABASE "'+dbName+'" WITH (FORCE)');await admin?.end();});
