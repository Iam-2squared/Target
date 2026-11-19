'use strict';
// Fresh disposable loopback database only. No hosted or learner data.
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs/promises');
const path=require('node:path');
const {Client}=require('pg');
const {generateQuestions}=require('../server/questions.cjs');
const {books}=require('../public/materials.js');
const root=path.resolve(__dirname,'..');
const migrationName='20261118132149_crown_improve_study_materials.sql';
const uid=()=>crypto.randomUUID(),secret=crypto.randomBytes(40).toString('hex');
const name='target_custom_books_'+process.pid+'_'+crypto.randomBytes(4).toString('hex')+'_test';
const actor=name=>({memberId:uid(),name});
const alice=actor('Custom Units'),bob=actor('Legacy Grandmaster'),locked=actor('Shared Reward Gate');
let admin,db,created=false,checks=0;
const eq=(a,b,label)=>{checks++;assert.deepEqual(a,b,label);};
const ok=(v,label)=>{checks++;assert(v,label);};
async function rpc(who,action,params={}){
 return(await db.query('SELECT public.target_rpc($1,$2,$3::jsonb) value',[secret,action,JSON.stringify({...who,...params})])).rows[0].value;
}
async function badge(who){return(await db.query('SELECT public.target_badge_rpc($1,$2,$3::jsonb) value',[secret,'list',JSON.stringify(who)])).rows[0].value;}
async function mastery(who,book){const value=await rpc(who,'mastery',{book});ok(!value.error,JSON.stringify(value));return value;}
async function start(who,book,from,to,options={}){
 const requestId=options.requestId??uid(),direction=options.direction??'japanese';
 const questions=generateQuestions({book,from,to,count:100,direction,requestId}).sort((a,b)=>a.number-b.number);
 const input={book,from,to,direction,requestId,questions};
 const value=await rpc(who,'start',input);ok(!value.error,JSON.stringify(value));
 eq(value.total,questions.length,'real short units use their actual question count');
 return {input,value,questions};
}
async function answer(who,quiz,index,correct=true,requestId=uid()){
 const q=quiz.questions[index];
 const input={quizId:quiz.value.quizId,questionId:q.id,choiceId:correct?q.correctChoiceId:q.choices.find(c=>c.id!==q.correctChoiceId).id,requestId};
 const value=await rpc(who,'answer',input);ok(!value.error,JSON.stringify(value));eq(value.correct,correct);return {input,value};
}
async function allCorrect(who,quiz){for(let i=0;i<quiz.questions.length;i++)await answer(who,quiz,i);}
async function rows(){
 const tables=(await db.query("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='target_private' AND c.relkind='r' ORDER BY c.relname")).rows;
 const hashes={};
 for(const {relname}of tables){assert(/^[a-z0-9_]+$/.test(relname));hashes[relname]=(await db.query('SELECT md5(coalesce(string_agg(to_jsonb(t)::text,\'\' ORDER BY to_jsonb(t)::text),\'\')) hash FROM target_private.'+relname+' t')).rows[0].hash;}
 return hashes;
}
async function functions(){return(await db.query("SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_array(md5(p.prosrc),p.prosecdef,p.proconfig,p.proacl)) value FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('public','target_private')")).rows[0].value;}
async function schema(){return(await db.query(`SELECT jsonb_build_object(
 'tables',(SELECT jsonb_agg(jsonb_build_array(c.relname,c.relrowsecurity,c.relacl) ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='target_private' AND c.relkind='r'),
 'indexes',(SELECT jsonb_agg(jsonb_build_array(tablename,indexname,indexdef) ORDER BY tablename,indexname) FROM pg_indexes WHERE schemaname='target_private'),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(t.tgrelid::regclass::text,t.tgname,t.tgenabled::text,pg_get_triggerdef(t.oid)) ORDER BY t.tgrelid::regclass::text,t.tgname) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='target_private' AND NOT t.tgisinternal)
 ) value`)).rows[0].value;}
async function reconcile(){eq((await db.query('SELECT count(*)::integer n FROM target_private.profiles p JOIN target_private.wallet_finance_projection(NULL) f USING(member_id) WHERE (p.total_points,p.spent_points,p.casino_net) IS DISTINCT FROM(f.total_points,f.spent_points,f.casino_net)')).rows[0].n,0,'all wallets reconcile with the unchanged immutable-history projection');}
async function main(){
 eq(process.env.NODE_ENV,'test');const url=new URL(process.env.DATABASE_URL||'');
 ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&!url.search&&!url.hash,'loopback-only disposable database');
 const owner=new URL(url);owner.pathname='/postgres';admin=new Client({connectionString:owner.href});await admin.connect();
 await admin.query('CREATE DATABASE "'+name+'"');created=true;url.pathname='/'+name;db=new Client({connectionString:url.href});await db.connect();
 await db.query("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN;END IF;IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN;END IF;IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN;END IF;END $$");
 const dir=path.join(root,'supabase/migrations');
 for(const file of(await fs.readdir(dir)).filter(x=>/^\d+_.*\.sql$/.test(x)&&x!==migrationName).sort())await db.query(await fs.readFile(path.join(dir,file),'utf8'));
 await db.query("INSERT INTO target_private.server_credentials(singleton,key_hash) VALUES(true,encode(sha256(convert_to($1,'UTF8')),'hex'))",[secret]);
 for(const who of[alice,bob,locked])await db.query('INSERT INTO target_private.profiles(member_id,name) VALUES($1,$2)',[who.memberId,who.name]);
 // Seed only legacy learning rows, with their existing fixed storage charge.
 await db.query("INSERT INTO target_private.word_mastery(member_id,book,word_number,correct_streak,needs_review) SELECT $1,'target1000',n,2,false FROM generate_series(1,100)n",[bob.memberId]);
 await db.query("INSERT INTO target_private.word_mastery(member_id,book,word_number,correct_streak,needs_review) VALUES($1,'kobun400',400,0,true)",[bob.memberId]);
 for(const [book,count]of[['target1900',19],['target1000',10],['kobun400',4]])await db.query("INSERT INTO target_private.section_mastery_achievements(member_id,book,section,recorded_from) SELECT $1,$2,n,'answer' FROM generate_series(1,$3)n",[bob.memberId,book,count]);
 await db.query('UPDATE target_private.system_state SET logical_bytes=logical_bytes+(101+33)*256 WHERE singleton');
 const oldQuiz=await start(alice,'target1900',1,2);const oldAnswer=await answer(alice,oldQuiz,0);
 const oldMastery={};for(const book of['target1900','target1000','kobun400'])oldMastery[book]=await mastery(bob,book);
 const oldBadge=await badge(bob);eq(oldBadge.sectionTotal,33);eq(oldBadge.completedSections,33);eq(oldBadge.earnedIds.length,37);eq(oldBadge.earnedIds.at(-1),'grand:all');
 await reconcile();const beforeRows=await rows(),beforeFunctions=await functions(),beforeSchema=await schema();
 const oldSource=(await db.query("SELECT prosrc FROM pg_proc WHERE oid='public.target_rpc(text,text,jsonb)'::regprocedure")).rows[0].prosrc;
 await db.query(await fs.readFile(path.join(dir,migrationName),'utf8'));
 eq(await rows(),beforeRows,'migration changes no retained private row, money, item, history, mastery, badge or quota');
 eq(await schema(),beforeSchema,'all table ACL/RLS, indexes and triggers are preserved');
 const afterFunctions=await functions();const allowed=['target_rpc(text,text,jsonb)','public.target_rpc(text,text,jsonb)','target_private.mastery_snapshot(uuid,text)','target_private.record_section_mastery_achievement()','target_badge_rpc(text,text,jsonb)','public.target_badge_rpc(text,text,jsonb)'];
 for(const [signature,definition]of Object.entries(beforeFunctions)){
  if(allowed.includes(signature))eq(afterFunctions[signature].slice(1),definition.slice(1),'changed function retains security, search path and ACL: '+signature);
  else eq(afterFunctions[signature],definition,'unrelated function is byte-identical: '+signature);
 }
 const actualSource=(await db.query("SELECT prosrc FROM pg_proc WHERE oid='public.target_rpc(text,text,jsonb)'::regprocedure")).rows[0].prosrc;
 eq(actualSource,oldSource.replaceAll("coalesce(p_input->>'book','') NOT IN ('target1900','target1000','kobun400')","coalesce(p_input->>'book','') NOT IN ('target1900','target1000','kobun400','crown','improve','cnn')").replace("CASE selected_book WHEN 'target1900' THEN 1900 WHEN 'target1000' THEN 1000 WHEN 'kobun400' THEN 400 ELSE 0 END",'target_private.study_book_size(selected_book)'),'normal RPC differs ONLY in three planned material expressions');
 for(const book of['target1900','target1000','kobun400'])eq(await mastery(bob,book),oldMastery[book],'legacy mastery response unchanged: '+book);
 eq(await badge(bob),oldBadge,'legacy 33-section grand badge exact response preserved');
 const replay=await rpc(alice,'answer',oldAnswer.input);eq(replay,oldAnswer.value,'accepted historical answer replays exactly');
 await answer(alice,oldQuiz,1);eq((await rpc(alice,'start',oldQuiz.input)).quizId,oldQuiz.value.quizId,'old in-flight quiz still completes and replays');
 for(const [book,material]of Object.entries(books)){
  const actual=(await db.query('SELECT * FROM target_private.study_sections($1) ORDER BY section',[book])).rows;
  eq(actual,material.sections.map(({section,from,to})=>({section,first_number:from,last_number:to})),'SQL section map matches shared catalog: '+book);
  eq((await db.query('SELECT target_private.study_book_size($1) n',[book])).rows[0].n,material.total);
 }
 eq((await db.query("SELECT target_private.study_book_size('unknown') n")).rows[0].n,0);
 eq((await db.query("SELECT * FROM target_private.study_sections('unknown')")).rows,[]);
 eq((await rpc(alice,'mastery',{book:'unknown'})).error.code,'INVALID_REQUEST');
 for(const role of['anon','authenticated','service_role']){
  for(const signature of['target_private.study_book_size(text)','target_private.study_sections(text)','target_private.mastery_snapshot(uuid,text)','target_private.record_section_mastery_achievement()'])ok(!(await db.query('SELECT has_function_privilege($1,$2,\'EXECUTE\') allowed',[role,signature])).rows[0].allowed,'private helper not callable: '+role+' '+signature);
  for(const relation of['target_private.word_mastery','target_private.section_mastery_achievements','target_private.quizzes'])ok(!(await db.query('SELECT has_table_privilege($1,$2,\'SELECT\') allowed',[role,relation])).rows[0].allowed,'learning source stays private');
 }
 for(const [book,total]of[['crown',32],['improve',42],['cnn',24]]){
  const empty=await mastery(alice,book);eq(empty.sections.map(s=>[s.section,s.from,s.to,s.total]),books[book].sections.map(s=>[s.section,s.from,s.to,s.to-s.from+1]));
  eq(empty.sections.map(s=>s.percent),books[book].sections.map(()=>0));
  const first=await start(alice,book,1,total);await allCorrect(alice,first);
  eq((await mastery(alice,book)).sections.map(s=>s.mastered),books[book].sections.map(()=>0),'one correct is not mastery');
  const second=await start(alice,book,1,total);
  for(let i=0;i<second.questions.length;i++){
   if(book==='crown'&&i===16){const partial=await mastery(alice,book);eq(partial.sections[0].mastered,16);eq(partial.sections[0].percent,94);eq(partial.sections[0].achievers,[]);}
   await answer(alice,second,i);
  }
  const complete=await mastery(alice,book);
  for(const s of complete.sections){eq(s.mastered,s.total);eq(s.percent,100);eq(s.reviewCount,0);eq(s.achievers.map(a=>[a.memberId,a.name]),[[alice.memberId,alice.name]]);}
  eq((await mastery(bob,book)).sections.map(s=>s.mastered),books[book].sections.map(()=>0),'member mastery is isolated');
  eq((await badge(alice)).earnedIds,[],'new sections do not leak unsupported IDs into the legacy KGS badge bridge');
 }
 // A legacy grandmaster can learn new books without losing the old badge.
 await db.query("INSERT INTO target_private.section_mastery_achievements(member_id,book,section,recorded_from) VALUES($1,'crown',6,'answer')",[bob.memberId]);
 await db.query('UPDATE target_private.system_state SET logical_bytes=logical_bytes+256 WHERE singleton');
 eq(await badge(bob),oldBadge,'new achievement cannot revoke or expand the legacy external grand badge');
 const wrong=await start(alice,'cnn',24,24);await answer(alice,wrong,0,false);
 let state=await mastery(alice,'cnn');eq(state.reviewNumbers,[24]);eq(state.sections[0].mastered,23);eq(state.sections[0].percent,95);eq(state.sections[0].reviewCount,1);eq(state.sections[0].achievers.length,1,'once-ever achiever survives later mistake');
 for(let n=0;n<2;n++){
  const requestId=uid(),input={book:'cnn',direction:'japanese',from:1,to:24,count:10,requestId};
  const pool=await rpc(alice,'review_start',input);eq(pool.reviewNumbers,[24]);
  const questions=generateQuestions(input,pool.reviewNumbers);
  const value=await rpc(alice,'review_start',{...input,questions});ok(!value.error,JSON.stringify(value));eq(value.total,1);
  const reviewed={questions,value};await answer(alice,reviewed,0);
  state=await mastery(alice,'cnn');eq(state.reviewNumbers,n===0?[24]:[]);
 }
 eq(state.sections[0].percent,100);eq(state.sections[0].achievers.length,1,'review recovery never duplicates achievements');
 for(const book of['crown','improve']){const q=await start(locked,book,1,1);await answer(locked,q,0,false);}
 let gate=(await rpc(locked,'profile')).rewardLock;eq(gate.locked,true,'two misses across different new books share the account reward gate');
 const lockedPoints=(await rpc(locked,'profile')).totalPoints;
 for(const book of['cnn','crown','improve']){const q=await start(locked,book,1,1);const a=await answer(locked,q,0);eq(a.value.awardPoints,0,'recovery corrects do not pay');eq((await rpc(locked,'profile')).totalPoints,lockedPoints);}
 eq((await rpc(locked,'profile')).rewardLock.locked,false,'three corrects across books unlock the same account');
 for(const [book,bad]of[['crown',33],['improve',43],['cnn',25]]){
  await assert.rejects(()=>db.query('INSERT INTO target_private.word_mastery(member_id,book,word_number,correct_streak,needs_review) VALUES($1,$2,$3,0,true)',[alice.memberId,book,bad]),{code:'23514'});checks++;
  const invalid={...oldQuiz.input,book,from:1,to:bad,requestId:uid()};eq((await rpc(alice,'start',invalid)).error.code,'INVALID_RANGE');
 }
 for(const [book,section]of[['crown',1],['crown',8],['improve',7],['improve',12],['cnn',2]]){await assert.rejects(()=>db.query("INSERT INTO target_private.section_mastery_achievements(member_id,book,section,recorded_from) VALUES($1,$2,$3,'answer')",[alice.memberId,book,section]),{code:'23514'});checks++;}
 await reconcile();
 eq((await db.query("SELECT md5(prosrc) hash FROM pg_proc WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure")).rows[0].hash,'bd93399757a066fdfb8f35e7e29af2dc','financial projection source unchanged');
 const hashes=(await db.query("SELECT oid::regprocedure::text signature,md5(prosrc) hash FROM pg_proc WHERE oid IN('public.target_rpc(text,text,jsonb)'::regprocedure,'target_private.mastery_snapshot(uuid,text)'::regprocedure,'target_private.record_section_mastery_achievement()'::regprocedure,'public.target_badge_rpc(text,text,jsonb)'::regprocedure) ORDER BY oid::regprocedure::text")).rows;
 console.log(JSON.stringify({customStudyBooks:'passed',checks,rowsUnchangedOnMigration:true,legacyBadgeContractPreserved:true,functionHashes:hashes,hostedWrites:false}));
}
main().catch(e=>{console.error(e.stack||e);process.exitCode=1;}).finally(async()=>{if(db)await db.end();if(admin){if(created)await admin.query('DROP DATABASE "'+name+'"');await admin.end();}});
