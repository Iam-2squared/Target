'use strict';
// Real KGS identity HTTP + Target HTTP + private loopback PostgreSQL only.
// No hosted credentials, production accounts or mocked grading are used.
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process'),{once}=require('node:events'),{Client,Pool}=require('pg'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),kgsRoot=process.env.TARGET_KGS_SOURCE_ROOT||path.resolve(root,'../KGS01-gacha-100k/prototype/v2');
const targetBase='http://127.0.0.1:3270',kgsBase='http://127.0.0.1:3271',source=new URL(process.env.DATABASE_URL||'');
assert.equal(process.env.NODE_ENV,'test');assert(['localhost','127.0.0.1','[::1]'].includes(source.hostname),'Only loopback test databases are allowed.');
const targetURL=new URL(source.href),kgsURL=new URL(source.href);targetURL.pathname='/target_mastery_e2e_test';kgsURL.pathname='/kgs01_mastery_e2e_test';
const targetDb=new Pool({connectionString:targetURL.href}),kgsDb=new Pool({connectionString:kgsURL.href});
const uuid=()=>crypto.randomUUID(),opaque=()=>crypto.randomBytes(32).toString('base64url'),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const secrets=new Set([process.env.KGS_ADMIN_SECRET,process.env.KGS_SESSION_SECRET].filter(Boolean)),secret=x=>{secrets.add(x);return x;};
const rpcSecret=secret(opaque()),cookieSecret=secret(opaque()),integrationSecret=secret(opaque()),code=secret(crypto.randomInt(0,1000000).toString().padStart(6,'0'));
const pins=Array.from({length:3},()=>secret(String(crypto.randomInt(6000,9999))));
const redact=x=>{let s=String(x);for(const value of secrets)s=s.split(value).join('[credential]');return s;};
const uuidValue=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const textLeaves=x=>typeof x==='string'?[x]:x&&typeof x==='object'?Object.values(x).flatMap(textLeaves):[];
const reportDir=path.join(root,'test-results'),processes=new Map(),logs=new Map(),contexts=[],results=[],errors=[];
let browser,checks=0,failure,storageDir,originalOdds;
const ok=(x,label)=>{checks++;assert(x,label);},eq=(a,b,label)=>{checks++;assert.deepEqual(a,b,label);};
async function scenario(name,fn){const start=Date.now();try{await fn();results.push({name,status:'passed',durationMs:Date.now()-start});console.log('PASS '+name);}catch(e){results.push({name,status:'failed',error:redact(e.message).split('\n')[0]});throw e;}}
async function context(){const c=await browser.newContext({viewport:{width:390,height:844}});contexts.push(c);return c;}
async function request(c,base,route,body,status=200,extraHeaders={}){
  const r=await c.request.fetch(base+route,{method:body===undefined?'GET':'POST',headers:{Origin:base,'Content-Type':'application/json',...extraHeaders},...(body===undefined?{}:{data:body}),timeout:25000});
  const data=await r.json();eq(r.status(),status,route+' '+(data.error?.code||'ok'));ok(/no-store/.test(r.headers()['cache-control']||''),'Private responses are no-store.');
  // Random four-digit PINs can occur by chance inside legitimate random UUIDs.
  // Inspect short credentials in response text, excluding complete UUID tokens;
  // long server credentials must still be absent from the entire serialized DTO.
  const serialized=JSON.stringify(data),copy=textLeaves(data).filter(text=>!uuidValue.test(text));
  for(const value of secrets)ok(value.length<16?copy.every(text=>!text.includes(value)):!serialized.includes(value),'The response contains no server credential.');return data;
}
const target=(c,route,body,status=200,headers={})=>request(c,targetBase,route,body,status,headers);
const kgs=(c,route,body,status=200,headers={})=>request(c,kgsBase,route,body,status,headers);
async function fresh(url,folder){
  const adminURL=new URL(source.href);adminURL.pathname='/postgres';const admin=new Client({connectionString:adminURL.href});await admin.connect();
  try{await admin.query('DROP DATABASE IF EXISTS "'+url.pathname.slice(1)+'" WITH (FORCE)');await admin.query('CREATE DATABASE "'+url.pathname.slice(1)+'"');}finally{await admin.end();}
  const c=new Client({connectionString:url.href});await c.connect();try{for(const name of(await fs.readdir(folder)).filter(n=>/^\d+_.*\.sql$/.test(n)).sort()){await c.query('BEGIN');try{await c.query(await fs.readFile(path.join(folder,name),'utf8'));await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}}}finally{await c.end();}
}
function environment(kind){const common={...process.env,NODE_ENV:'test',VERCEL:'',KGS_TARGET_INTEGRATION_SECRET:integrationSecret,KGS_SPECIAL99_PROVISION_REQUEST:'',KGS_ATTENDANCE_PROVISION_REQUEST:'',KGS_PUSH_PUBLIC_KEY:'',KGS_PUSH_PRIVATE_KEY:'',KGS_PUSH_CRON_SECRET:'',KGS_PUSH_SUBJECT:''};return kind==='kgs'?{...common,DATABASE_URL:kgsURL.href,KGS_ALLOWED_ORIGINS:kgsBase,KGS_TARGET_APP_URL:targetBase,KGS_STORAGE_DRIVER:'local',KGS_LOCAL_STORAGE_DIR:storageDir,PORT:'3271'}:{...common,TARGET_DATABASE_URL:targetURL.href,TARGET_RPC_SECRET:rpcSecret,TARGET_COOKIE_SECRET:cookieSecret,KGS_IDENTITY_URL:kgsBase,TARGET_ALLOWED_ORIGINS:targetBase,PORT:'3270'};}
async function start(kind){const cwd=kind==='kgs'?kgsRoot:root,p=spawn(process.execPath,[path.join(cwd,kind==='kgs'?'server/dev.cjs':'scripts/dev.cjs')],{cwd,env:environment(kind),stdio:['ignore','pipe','pipe']});processes.set(kind,p);logs.set(kind,'');for(const s of[p.stdout,p.stderr])s.on('data',v=>logs.set(kind,logs.get(kind)+v));for(let i=0;i<100;i++){if(p.exitCode!==null||p.signalCode!==null)throw Error('Synthetic '+kind+' server stopped.');try{const r=await fetch((kind==='kgs'?kgsBase:targetBase)+'/api/session');if([200,401].includes(r.status))return;}catch{}await sleep(100);}throw Error('Local HTTP server did not start.');}
async function stop(kind){const p=processes.get(kind);if(p&&p.exitCode===null&&p.signalCode===null){p.kill('SIGTERM');await Promise.race([once(p,'close'),sleep(2500)]);if(p.exitCode===null&&p.signalCode===null){p.kill('SIGKILL');await Promise.race([once(p,'close'),sleep(1000)]);}}processes.delete(kind);}
const books={target1900:require('../data/target1900.json'),target1000:require('../data/target1000.json')};
function correctChoice(q,book='target1900',direction='english'){const row=books[book][q.number-1],choice=q.choices.find(x=>x.text===row[direction]);ok(choice,'An actual dataset entry selects the answer.');return choice;}
const answerInput=(q,choice)=>({quizId:q.quizId,questionId:q.question.id,choiceId:choice.id,requestId:uuid()});
const settings=(number=1,book='target1900',direction='english')=>({book,direction,count:10,from:number,to:number,requestId:uuid()});
async function attempt(c,number,isCorrect,{book='target1900',direction='english'}={}){const q=await target(c,'/api/quiz/start',settings(number,book,direction));eq(q.total,1);const good=correctChoice(q.question,book,direction),chosen=isCorrect?good:q.question.choices.find(x=>x.id!==good.id),input=answerInput(q,chosen),result=await target(c,'/api/quiz/answer',input);eq(result.correct,isCorrect);eq(result.finished,true);return{q,input,result};}
const mastery=(c,book='target1900')=>target(c,'/api/mastery?book='+book);
function section(snapshot,n){const found=snapshot.sections.find(x=>x.section===n);ok(found,'Section exists.');return found;}
async function page(c){const p=await c.newPage();await p.addInitScript(()=>localStorage.setItem('target-sound-enabled','false'));p.on('pageerror',e=>errors.push(e.message));await p.goto(targetBase,{waitUntil:'networkidle'});await p.waitForFunction(()=>!['接続中…','接続未確認'].includes(document.getElementById('accountBadge').textContent));return p;}
async function goHome(p){await p.locator('section.view:not([hidden]) [data-home]').first().click();await p.locator('#homeView').waitFor();}
async function logoutUI(p){await p.locator('#settingsOpen').click();await p.locator('#logoutButton').click();await p.waitForFunction(()=>document.getElementById('loggedInSettings').hidden);await p.locator('#settingsClose').click();}
async function homeCount(p,value){await p.waitForFunction(value=>document.getElementById('homeReviewCount').textContent===value,value);eq(await p.locator('#homeReviewCount').innerText(),value);}
async function answerCorrectUI(p){
  await p.locator('#questionChoices button').first().waitFor();
  const numberText=await p.locator('#questionNumber').innerText(),number=Number(numberText.replace(/\D/g,''));
  const texts=await p.locator('#questionChoices .choice-text').allTextContents(),index=texts.indexOf(books.target1900[number-1].english);ok(index>=0,'The UI offers the real correct answer.');
  const pending=p.waitForResponse(r=>new URL(r.url()).pathname==='/api/quiz/answer');await p.locator('#questionChoices button').nth(index).click();
  const response=await pending,result=await response.json();eq(response.status(),200);eq(result.correct,true);eq(result.awardPoints,100);
  if(result.finished)await p.locator('#resultView').waitFor({timeout:3500});
  else await p.waitForFunction(previous=>document.getElementById('questionNumber').textContent!==previous,numberText);
  return{number,result};
}

(async()=>{let Admin,RegisterA,RegisterB,A,A2,B,Guest,memberA,memberB,pA,pGuest;
try{
  await fs.mkdir(reportDir,{recursive:true});storageDir=await fs.mkdtemp(path.join(os.tmpdir(),'target-mastery-files-'));
  await fresh(kgsURL,path.resolve(kgsRoot,'../../supabase/migrations'));await fresh(targetURL,path.join(root,'supabase/migrations'));
  await targetDb.query("INSERT INTO target_private.server_credentials(singleton,key_hash) VALUES(true,encode(sha256(convert_to($1,'UTF8')),'hex'))",[rpcSecret]);
  // This isolated suite has no random celebration timing; actual odds are tested
  // by bonus-db.cjs, and all grading/point grants still go through real HTTP.
  originalOdds=(await targetDb.query("SELECT pg_get_functiondef('target_private.reward_points_for_roll(integer)'::regprocedure) AS body")).rows[0].body;
  await targetDb.query('CREATE OR REPLACE FUNCTION target_private.reward_points_for_roll(p_roll integer) RETURNS integer LANGUAGE sql IMMUTABLE STRICT SECURITY INVOKER SET search_path=pg_catalog AS $$ SELECT 100 $$');
  await start('kgs');await start('target');browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  Admin=await context();RegisterA=await context();RegisterB=await context();A=await context();A2=await context();B=await context();Guest=await context();
  await kgs(Admin,'/api/admin/login',{secret:process.env.KGS_ADMIN_SECRET});await kgs(Admin,'/api/admin/code',{code});
  memberA=(await kgs(RegisterA,'/api/login',{code,attendanceNumber:1,accountPin:pins[0],register:true})).member;await kgs(RegisterA,'/api/profile',{name:'定着確認A'});
  memberB=(await kgs(RegisterB,'/api/login',{code,attendanceNumber:2,accountPin:pins[1],register:true})).member;await kgs(RegisterB,'/api/profile',{name:'定着確認B'});
  await target(A,'/api/login',{attendanceNumber:1,accountPin:pins[0]});await target(A2,'/api/login',{attendanceNumber:1,accountPin:pins[0]});await target(B,'/api/login',{attendanceNumber:2,accountPin:pins[1]});

  await scenario('Private mastery has 19/10 exact denominators and requires a server identity',async()=>{
    await target(Guest,'/api/mastery?book=target1900',undefined,401);await target(Guest,'/api/quiz/review/start',settings(),401);
    await target(A,'/api/mastery?book=other',undefined,400);await target(A,'/api/quiz/review/start',{...settings(),memberId:memberB.id},400);
    await target(A,'/api/quiz/review/start',settings(),403,{Origin:'https://untrusted.invalid'});
    for(const[book,total]of[['target1900',19],['target1000',10]]){const m=await mastery(A,book);eq(m.book,book);eq(m.sections.length,total);eq(m.reviewNumbers,[]);for(let i=0;i<total;i++)eq(m.sections[i],{section:i+1,from:i*100+1,to:(i+1)*100,total:100,mastered:0,percent:0,reviewCount:0});}
    const ordinary=await mastery(A);
    eq(await target(A,'/api/mastery?book=target1900&route=mastery'),ordinary,'Vercel routing metadata preserves the authenticated mastery response.');
    eq(await target(A,'/api/index?route=mastery&book=target1900'),ordinary,'The internal rewrite entry reaches the same private mastery data.');
    eq(await target(A,'/api/mastery?book=target1900&route=mastery&path=mastery'),ordinary,'Matching Vercel catch-all path metadata preserves private mastery.');
    eq(await target(A,'/api/index?route=mastery&book=target1900&path=mastery'),ordinary,'The internal rewrite accepts matching catch-all path metadata.');
    await target(A,'/api/mastery?book=target1900&route=mastery&route=mastery',undefined,400);
    await target(A,'/api/index?route=mastery&book=target1900&route=mastery',undefined,400);
    await target(A,'/api/mastery?book=target1900&route=ranking',undefined,400);
    await target(A,'/api/mastery?book=target1900&route=mastery&path=mastery&path=mastery',undefined,400);
    await target(A,'/api/index?route=mastery&book=target1900&path=mastery&path=mastery',undefined,400);
    await target(A,'/api/mastery?book=target1900&route=mastery&path=ranking',undefined,400);
  });

  await scenario('Two consecutive correct answers persist across devices and directions; replay cannot learn twice',async()=>{
    const first=await attempt(A,1,true);let m=await mastery(A2);eq(section(m,1).mastered,0);eq(m.reviewNumbers,[]);
    eq(await target(A2,'/api/quiz/answer',first.input),first.result,'Identical answer replay returns the same receipt.');eq(await target(A,'/api/quiz/answer',{...first.input,requestId:uuid()}),first.result,'An alternate request ID cannot count as another correct answer.');
    eq((await targetDb.query('SELECT correct_streak,needs_review FROM target_private.word_mastery WHERE member_id=$1 AND book=$2 AND word_number=1',[memberA.id,'target1900'])).rows,[{correct_streak:1,needs_review:false}]);
    await attempt(A2,1,true,{direction:'japanese'});m=await mastery(A);eq(section(m,1).mastered,1);eq(section(m,1).percent,1);eq(m.reviewNumbers,[]);
    await attempt(A,1,false);m=await mastery(A2);eq(section(m,1).mastered,0);eq(section(m,1).reviewCount,1);eq(m.reviewNumbers,[1]);
    await attempt(A2,1,true);m=await mastery(A);eq(section(m,1).mastered,0);eq(m.reviewNumbers,[1],'One correct after a miss is still review material.');
    await attempt(A,1,true,{direction:'japanese'});m=await mastery(A2);eq(section(m,1).mastered,1);eq(m.reviewNumbers,[],'Two new consecutive correct answers restore mastery.');
    await attempt(A,1,false);await attempt(A,101,false);await attempt(A,1900,false);await attempt(A,1,false,{book:'target1000'});
    m=await mastery(A2);eq(m.reviewNumbers,[1,101,1900]);eq(section(m,1).reviewCount,1);eq(section(m,2).reviewCount,1);eq(section(m,19).reviewCount,1);eq((await mastery(A,'target1000')).reviewNumbers,[1]);
    const other=await mastery(B);eq(other.reviewNumbers,[]);ok(other.sections.every(s=>s.mastered===0&&s.reviewCount===0),'Another member has an independent empty learning history.');
  });

  await scenario('Review uses only missed, not-yet-mastered words in the selected book and Section',async()=>{
    const input={book:'target1900',direction:'english',count:100,from:1,to:100,requestId:uuid()},q=await target(A,'/api/quiz/review/start',input);eq(q.total,1,'A one-word review does not repeat the word to fill 100 slots.');eq(q.question.number,1);ok(!('correctChoiceId'in q.question),'A review starts without exposing its answer key.');
    const receipt=await target(A,'/api/quiz/answer',answerInput(q,correctChoice(q.question)));eq(receipt.correct,true);eq((await mastery(A2)).reviewNumbers,[1,101,1900]);
    const replay=await target(A2,'/api/quiz/review/start',input);eq(replay.quizId,q.quizId);eq(replay.answeredCount,1,'Review start replay remains its original quiz after answering.');
    const q2=await target(A2,'/api/quiz/review/start',{...input,requestId:uuid(),direction:'japanese'});eq(q2.total,1);eq(q2.question.number,1);await target(A2,'/api/quiz/answer',answerInput(q2,correctChoice(q2.question,'target1900','japanese')));
    eq((await mastery(A)).reviewNumbers,[101,1900]);eq(section(await mastery(A),1).mastered,1);const empty=await target(A,'/api/quiz/review/start',{...input,requestId:uuid()},409);eq(empty.error.code,'REVIEW_EMPTY');
    const section2=await target(A,'/api/quiz/review/start',{...input,requestId:uuid(),from:101,to:200});eq(section2.total,1);eq(section2.question.number,101);await target(A,'/api/quiz/answer',answerInput(section2,correctChoice(section2.question)));
    const idiom=await target(A,'/api/quiz/review/start',{...input,requestId:uuid(),book:'target1000'});eq(idiom.total,1);eq(idiom.question.number,1);await target(A,'/api/quiz/answer',answerInput(idiom,correctChoice(idiom.question,'target1000')));
    const broad=await target(A,'/api/quiz/review/start',{...input,requestId:uuid(),to:1900});eq(broad.total,2);ok([101,1900].includes(broad.question.number),'Unattempted and mastered words are absent from review.');
    await target(B,'/api/quiz/review/start',input,409);eq((await mastery(B)).reviewNumbers,[]);
  });

  await scenario('Learning rows outlive disposable quiz history and survive an HTTP server restart',async()=>{
    const before=await mastery(A2),income=(await target(A,'/api/session')).totalIncome;ok(income>0,'Recorded correct answers continue earning the real server reward.');
    await targetDb.query("UPDATE target_private.quizzes SET expires_at=clock_timestamp()-interval '8 days'");await target(B,'/api/quiz/start',settings(2));
    eq(Number((await targetDb.query('SELECT count(*) AS n FROM target_private.answers WHERE member_id=$1',[memberA.id])).rows[0].n),0,'Old answer detail is actually cleaned by the normal start path.');
    eq(await mastery(A),before,'Mastery survives normal answer-detail retention cleanup.');await stop('target');await start('target');eq(await mastery(A2),before,'A second cookie context can read persisted mastery after restart.');eq((await target(A,'/api/session')).totalIncome,income,'Restart preserves earned income.');
  });

  await scenario('Home shows all-Section review counts, fits five widths and requires login for private history',async()=>{
    await attempt(A,201,false);eq((await mastery(A)).reviewNumbers,[101,201,1900]);
    pA=await page(A);await homeCount(pA,'3個');await pA.locator('#masteryOpen').click();await pA.locator('#masteryList .mastery-row').first().waitFor();eq(await pA.locator('#masteryList .mastery-row').count(),19);eq(await pA.locator('#masteryList [data-section="1"] .mastery-percent').innerText(),'1%');
    for(const width of[320,375,390,430,1280]){await pA.setViewportSize({width,height:844});ok(await pA.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Mastery fits '+width+'px.');const box=await pA.locator('#masteryList .mastery-row').first().boundingBox();ok(box.x>=-1&&box.x+box.width<=width+1,'Section row stays inside '+width+'px.');await pA.screenshot({path:path.join(reportDir,'mastery-'+width+'.png'),fullPage:false});}
    await goHome(pA);await homeCount(pA,'3個');for(const width of[320,375,390,430,1280]){await pA.setViewportSize({width,height:844});ok(await pA.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Home review actions fit '+width+'px.');for(const id of['masteryOpen','reviewOpen']){const box=await pA.locator('#'+id).boundingBox();ok(box.width>25&&box.height>=30,'The '+id+' control remains tappable.');}const countBox=await pA.locator('#homeReviewCount').boundingBox(),reviewBox=await pA.locator('#reviewOpen').boundingBox();ok(reviewBox.y>=countBox.y+countBox.height,'The review action is below its count at '+width+'px.');await pA.screenshot({path:path.join(reportDir,'review-home-'+width+'.png'),fullPage:false});}
    await pA.locator('#bookSelect').selectOption('target1000');await homeCount(pA,'1個');await pA.locator('#reviewOpen').click();const idiomRequest=pA.waitForRequest(r=>new URL(r.url()).pathname==='/api/quiz/review/start');await pA.locator('#testStart').click();const idiomSettings=(await idiomRequest).postDataJSON();eq({book:idiomSettings.book,from:idiomSettings.from,to:idiomSettings.to},{book:'target1000',from:1,to:1000},'Idiom review also posts its whole book.');await pA.locator('#questionChoices button').first().waitFor();await pA.locator('#quizQuit').click();await pA.locator('#quitConfirm').click();await homeCount(pA,'1個');await pA.locator('#masteryOpen').click();await pA.waitForFunction(()=>document.querySelectorAll('#masteryList .mastery-row').length===10);eq(await pA.locator('#masteryBook').innerText(),'英熟語Target 1000');
    pGuest=await page(Guest);await homeCount(pGuest,'—');ok((await pGuest.locator('#homeReviewStatus').innerText()).includes('ログイン'),'A guest sees a login state instead of zero missed words.');eq(await pGuest.locator('#homeReviewRetry').isVisible(),false);await pGuest.locator('#masteryOpen').click();await pGuest.locator('#masteryLogin').waitFor({state:'visible'});eq(await pGuest.locator('#masteryList .mastery-row').count(),0,'A guest is not shown fabricated zero-percent account history.');await pGuest.locator('#masteryLogin').click();ok(await pGuest.locator('#settingsDialog').isVisible());await pGuest.locator('#settingsClose').click();await goHome(pGuest);await pGuest.locator('#reviewOpen').click();await pGuest.locator('#reviewLogin').waitFor({state:'visible'});eq(await pGuest.locator('#testStart').isDisabled(),true,'A guest cannot start a shared review.');eq(await pGuest.locator('#testSectionRange').isVisible(),false);
  });

  await scenario('Review ignores the saved Section while ordinary tests retain it and two correct answers clear the count',async()=>{
    await goHome(pA);await pA.setViewportSize({width:390,height:844});await pA.locator('#bookSelect').selectOption('target1900');await homeCount(pA,'3個');await pA.locator('#homeSectionFrom').selectOption('2');await pA.locator('#homeSectionTo').selectOption('2');await homeCount(pA,'3個');
    await pA.locator('#testOpen').click();eq(await pA.locator('#testSectionRange').isVisible(),true);eq(await pA.locator('#rangeFrom').isEnabled(),true);eq(await pA.locator('#rangeTo').isEnabled(),true);eq(await pA.locator('#rangeFrom').inputValue(),'2');eq(await pA.locator('#rangeTo').inputValue(),'2');
    const ordinary=pA.waitForRequest(r=>new URL(r.url()).pathname==='/api/quiz/start');await pA.locator('#testStart').click();const ordinarySettings=(await ordinary).postDataJSON();eq({book:ordinarySettings.book,from:ordinarySettings.from,to:ordinarySettings.to},{book:'target1900',from:101,to:200},'An ordinary test keeps the selected Section.');await pA.locator('#questionChoices button').first().waitFor();await pA.locator('#quizQuit').click();await pA.locator('#quitConfirm').click();await homeCount(pA,'3個');
    await pA.locator('#reviewOpen').click();eq(await pA.locator('#setupTitle').innerText(),'解き直し');eq(await pA.locator('#testSectionRange').isVisible(),false);eq(await pA.locator('#rangeFrom').isDisabled(),true);eq(await pA.locator('#rangeTo').isDisabled(),true);
    const startResponse=pA.waitForResponse(r=>new URL(r.url()).pathname==='/api/quiz/review/start');await pA.locator('#testStart').click();const response=await startResponse,input=response.request().postDataJSON(),started=await response.json();eq(response.status(),200);eq({book:input.book,from:input.from,to:input.to},{book:'target1900',from:1,to:1900},'Review posts the whole selected book.');eq(started.total,3);eq((await targetDb.query('SELECT questions FROM target_private.quizzes WHERE id=$1',[started.quizId])).rows[0].questions.map(q=>q.number).sort((a,b)=>a-b),[101,201,1900],'Real review questions include misses outside the saved Section.');
    const firstPass=[];for(let i=0;i<3;i++){const answered=await answerCorrectUI(pA);firstPass.push(answered.number);if(answered.number!==101)ok((await mastery(A2)).reviewNumbers.includes(answered.number),'The first correct answer after a miss keeps the word in review.');}eq(firstPass.sort((a,b)=>a-b),[101,201,1900]);eq((await mastery(A2)).reviewNumbers,[201,1900]);await goHome(pA);await homeCount(pA,'2個');
    await pA.locator('#reviewOpen').click();await pA.locator('#testStart').click();const secondPass=[];for(let i=0;i<2;i++){const answered=await answerCorrectUI(pA);secondPass.push(answered.number);ok(!(await mastery(A2)).reviewNumbers.includes(answered.number),'The second consecutive correct answer removes the word.');}eq(secondPass.sort((a,b)=>a-b),[201,1900]);await goHome(pA);await homeCount(pA,'0個');
    await pA.locator('#masteryOpen').click();await pA.locator('#masteryList [data-section="2"] .mastery-percent').waitFor();eq(await pA.locator('#masteryList [data-section="2"] .mastery-percent').innerText(),'1%');await goHome(pA);await pA.locator('#testOpen').click();eq(await pA.locator('#testSectionRange').isVisible(),true);eq(await pA.locator('#rangeFrom').isEnabled(),true);eq(await pA.locator('#rangeFrom').inputValue(),'2');eq(await pA.locator('#rangeTo').inputValue(),'2','Review never changes the saved Section.');await goHome(pA);await pA.locator('#reviewOpen').click();await pA.locator('#testStart').click();await pA.locator('#setupError').waitFor({state:'visible'});ok((await pA.locator('#setupError').innerText()).includes('解き直す単語はありません'));eq(await pA.locator('#testStart').isEnabled(),true);
  });

  await scenario('Home and mastery report connection failures and recover through their retry controls',async()=>{
    await pA.route('**/api/mastery?book=*',route=>route.abort('failed'));await goHome(pA);await pA.locator('#homeReviewRetry').waitFor({state:'visible'});await homeCount(pA,'—');ok((await pA.locator('#homeReviewStatus').innerText()).length>0,'A failed private read shows an error state.');await pA.unroute('**/api/mastery?book=*');await pA.locator('#homeReviewRetry').click();await homeCount(pA,'0個');eq(await pA.locator('#homeReviewRetry').isVisible(),false);
    await pA.route('**/api/mastery?book=*',route=>route.abort('failed'));await pA.locator('#masteryOpen').click();await pA.locator('#masteryError').waitFor({state:'visible'});ok((await pA.locator('#masteryError').innerText()).length>0);await pA.unroute('**/api/mastery?book=*');await pA.locator('#masteryRefresh').click();await pA.locator('#masteryList .mastery-row').first().waitFor();eq(await pA.locator('#masteryList .mastery-row').count(),19,'The refresh action recovers from a real fetch failure.');
  });

  await scenario('Malformed and late private responses cannot cross book or account changes',async()=>{
    await pA.route('**/api/mastery?book=*',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({book:'target1900',sections:[{section:1,from:1,to:100,total:100,mastered:200,percent:200,reviewCount:0}],reviewNumbers:[]})}));await goHome(pA);await pA.locator('#homeReviewRetry').waitFor({state:'visible'});await homeCount(pA,'—');await pA.locator('#masteryOpen').click();await pA.locator('#masteryError').waitFor({state:'visible'});eq(await pA.locator('#masteryList .mastery-row').count(),0,'An impossible percentage never becomes a learning result.');await pA.unroute('**/api/mastery?book=*');await goHome(pA);await homeCount(pA,'0個');
    let releaseBook,arrivedBook,heldBook=false;const bookGate=new Promise(r=>releaseBook=r),bookReady=new Promise(r=>arrivedBook=r);
    await pA.route('**/api/mastery?book=*',async route=>{if(heldBook)return route.continue();heldBook=true;const real=await route.fetch();arrivedBook();await bookGate;try{await route.fulfill({response:real});}catch{}});
    await pA.locator('#testOpen').click();await goHome(pA);await bookReady;await homeCount(pA,'—');await pA.locator('#bookSelect').selectOption('target1000');await homeCount(pA,'1個');releaseBook();await sleep(150);await homeCount(pA,'1個');await pA.unroute('**/api/mastery?book=*');await pA.locator('#bookSelect').selectOption('target1900');await homeCount(pA,'0個');
    let release,arrived,held=false;const gate=new Promise(r=>release=r),ready=new Promise(r=>arrived=r);
    await pA.route('**/api/mastery?book=*',async route=>{if(held)return route.continue();held=true;const real=await route.fetch();arrived();await gate;try{await route.fulfill({response:real});}catch{}});
    await pA.locator('#testOpen').click();await goHome(pA);await ready;await logoutUI(pA);release();await sleep(200);await pA.unroute('**/api/mastery?book=*');await homeCount(pA,'—');ok((await pA.locator('#homeReviewStatus').innerText()).includes('ログイン'),'An accepted earlier response cannot restore a logged-out count.');await pA.locator('#masteryOpen').click();await pA.locator('#masteryLogin').waitFor({state:'visible'});eq(await pA.locator('#masteryList .mastery-row').count(),0,'Logged-out mastery stays empty.');await goHome(pA);
    await pA.locator('#settingsOpen').click();await pA.locator('#attendanceNumber').fill('2');await pA.locator('#accountPin').fill(pins[1]);await pA.locator('#loginButton').click();await pA.waitForFunction(()=>!document.getElementById('loggedInSettings').hidden);await pA.locator('#settingsClose').click();await homeCount(pA,'0個');await pA.locator('#masteryOpen').click();await pA.locator('#masteryList .mastery-row').first().waitFor();ok((await pA.locator('#masteryList .mastery-percent').allTextContents()).every(t=>t==='0%'),'A new login does not inherit another account history.');
    eq(errors,[],'No unhandled browser errors.');for(const value of secrets)for(const output of logs.values())ok(!output.includes(value),'Runtime logs omit credentials.');
  });
}catch(e){failure=e;if(!results.some(r=>r.status==='failed'))results.push({name:'Mastery suite setup',status:'failed',error:redact(e.message).split('\n')[0]});console.error('FAIL '+redact(e.stack));}
finally{await browser?.close().catch(()=>{});await stop('target');await stop('kgs');if(originalOdds)try{await targetDb.query(originalOdds);}catch{}await Promise.allSettled([targetDb.end(),kgsDb.end()]);if(storageDir)await fs.rm(storageDir,{recursive:true,force:true}).catch(()=>{});const report={generatedAt:new Date().toISOString(),environment:'real loopback KGS and Target HTTP, dedicated PostgreSQL, independent Chromium cookie contexts',fixture:'Reward helper fixed to100 only in this disposable local DB; mastery/identity/grading all real',cloudVerified:false,physicalSafariVerified:false,checks,passed:results.filter(r=>r.status==='passed').length,failed:results.filter(r=>r.status==='failed').length,results};await fs.mkdir(reportDir,{recursive:true});await fs.writeFile(path.join(reportDir,'mastery-results.json'),JSON.stringify(report,null,2)+'\n');console.log(report.passed+' mastery scenarios passed; '+report.failed+' failed; '+checks+' assertions.');if(failure)process.exitCode=1;}
})().catch(e=>{console.error(redact(e.stack));process.exitCode=1;});
