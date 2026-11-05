'use strict';
// Real local servers and durable PostgreSQL. No cloud credentials or live pupils.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const crypto=require('node:crypto'),{spawn,execFileSync}=require('node:child_process'),{once}=require('node:events');
const {Client,Pool}=require('pg'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
const kgsRoot=process.env.TARGET_KGS_SOURCE_ROOT||path.resolve(root,'../KGS01-target-identity/prototype/v2');
const targetBase='http://127.0.0.1:3220',kgsBase='http://127.0.0.1:3221',brokenBase='http://127.0.0.1:3222';
const source=new URL(process.env.DATABASE_URL||'');
assert.equal(process.env.NODE_ENV,'test');
assert(['localhost','127.0.0.1','[::1]'].includes(source.hostname),'Local PostgreSQL is required');
const kgsDatabase=new URL(source.href),targetDatabase=new URL(source.href);kgsDatabase.pathname='/kgs01_target_identity_test';targetDatabase.pathname='/target_study_test';
const kgsDb=new Pool({connectionString:kgsDatabase.href}),targetDb=new Pool({connectionString:targetDatabase.href});
const uuid=()=>crypto.randomUUID(),opaque=()=>crypto.randomBytes(32).toString('base64url');
const secretSet=new Set([process.env.KGS_ADMIN_SECRET,process.env.KGS_SESSION_SECRET].filter(Boolean));
const remember=value=>{secretSet.add(value);return value;};
const integrationSecret=remember(opaque()),rpcSecret=remember(opaque()),cookieSecret=remember(opaque());
const code=remember(crypto.randomInt(0,1000000).toString().padStart(6,'0')),codeChanged=remember(crypto.randomInt(0,1000000).toString().padStart(6,'0'));
const usedPins=new Set();
function pin(){let value;do{value=crypto.randomInt(0,10000).toString().padStart(4,'0');}while(usedPins.has(value)||/^(\d)\1{3}$/.test(value));usedPins.add(value);return remember(value);}
const pinA=pin(),pinB=pin(),pinNew=pin(),pinWrong=pin(),pinRate=pin(),pinSpecial=pin();
const redact=value=>{let text=String(value);for(const value of secretSet)text=text.split(value).join('[credential]');return text;};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const processes=new Map(),serverLogs=new Map(),results=[],runtimeErrors=[];
let checks=0,browser,Admin,KgsA,KgsB,A,B,Guest,memberA,memberB;
const reportDir=path.join(root,'test-results');
function ok(value,label){checks++;assert(value,label);}
function eq(value,expected,label){checks++;assert.deepEqual(value,expected,label);}
async function scenario(name,fn){const start=Date.now();try{await fn();results.push({name,status:'passed',durationMs:Date.now()-start});console.log('PASS '+name);}catch(error){results.push({name,status:'failed',durationMs:Date.now()-start,error:redact(error.message).split('\n')[0]});throw error;}}
async function makeContext(){return browser.newContext({viewport:{width:390,height:900}});}
async function request(context,base,route,input,status=200,extra={}){
  const response=await context.request.fetch(base+route,{method:input===undefined?'GET':'POST',headers:{Origin:base,'Content-Type':'application/json',...extra},...(input===undefined?{}:{data:input}),timeout:25000});
  const data=await response.json();eq(response.status(),status,route+' status ('+(data.error?.code||'ok')+')');
  for(const secret of [integrationSecret,rpcSecret,cookieSecret,process.env.KGS_ADMIN_SECRET,process.env.KGS_SESSION_SECRET])ok(!JSON.stringify(data).includes(secret),'API excludes private server credentials');
  if(route.startsWith('/api/'))ok(/private/.test(response.headers()['cache-control']||'')&&/no-store/.test(response.headers()['cache-control']||''),'Private API responses cannot enter shared caches');
  return data;
}
const target=(c,route,input,status=200,extra={})=>request(c,targetBase,route,input,status,extra);
const kgs=(c,route,input,status=200,extra={})=>request(c,kgsBase,route,input,status,extra);
const bridge=(c,action,input,status=200)=>kgs(c,'/api/integrations/target/'+action,input,status,{Authorization:'Bearer '+integrationSecret});
const classSession=c=>kgs(c,'/api/session');
async function freshDatabase(url,folder){
  const adminUrl=new URL(source.href);adminUrl.pathname='/postgres';const admin=new Client({connectionString:adminUrl.href});await admin.connect();
  try{await admin.query('DROP DATABASE IF EXISTS "'+url.pathname.slice(1)+'" WITH (FORCE)');await admin.query('CREATE DATABASE "'+url.pathname.slice(1)+'"');}finally{await admin.end();}
  const client=new Client({connectionString:url.href});await client.connect();try{
    for(const name of (await fs.readdir(folder)).filter(name=>/^\d+_.*\.sql$/.test(name)).sort()){
      await client.query('BEGIN');try{await client.query(await fs.readFile(path.join(folder,name),'utf8'));await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}
    }
  }finally{await client.end();}
}
function serverEnvironment(kind){
  const base={...process.env,NODE_ENV:'test',VERCEL:'',KGS_TARGET_INTEGRATION_SECRET:integrationSecret,KGS_PUSH_PUBLIC_KEY:'',KGS_PUSH_PRIVATE_KEY:'',KGS_PUSH_CRON_SECRET:'',KGS_PUSH_SUBJECT:''};
  if(kind==='kgs')return{...base,DATABASE_URL:kgsDatabase.href,KGS_ALLOWED_ORIGINS:kgsBase,PORT:'3221',KGS_STORAGE_DRIVER:'local',KGS_LOCAL_STORAGE_DIR:path.join(os.tmpdir(),'kgs-target-identity-storage')};
  const env={...base,TARGET_DATABASE_URL:targetDatabase.href,TARGET_RPC_SECRET:rpcSecret,TARGET_COOKIE_SECRET:cookieSecret,KGS_IDENTITY_URL:kgsBase,TARGET_ALLOWED_ORIGINS:kind==='broken'?brokenBase:targetBase,PORT:kind==='broken'?'3222':'3220'};
  if(kind==='broken')delete env.TARGET_COOKIE_SECRET;
  return env;
}
async function start(kind){
  const cwd=kind==='kgs'?kgsRoot:root,entry=kind==='kgs'?'server/dev.cjs':'scripts/dev.cjs';
  const child=spawn(process.execPath,[path.join(cwd,entry)],{cwd,env:serverEnvironment(kind),stdio:['ignore','pipe','pipe']});processes.set(kind,child);serverLogs.set(kind,'');
  child.stdout.on('data',v=>serverLogs.set(kind,serverLogs.get(kind)+v));child.stderr.on('data',v=>serverLogs.set(kind,serverLogs.get(kind)+v));
  const base=kind==='kgs'?kgsBase:kind==='broken'?brokenBase:targetBase;
  for(let n=0;n<100;n++){if(child.exitCode!==null)throw Error('Synthetic '+kind+' server exited before readiness');try{const res=await fetch(base+'/api/session');if([200,401,503].includes(res.status))return;}catch{}await sleep(100);}
  throw Error('Synthetic '+kind+' server was not ready');
}
async function stop(kind){const child=processes.get(kind);if(child&&child.exitCode===null){child.kill('SIGTERM');await Promise.race([once(child,'close'),sleep(3000)]);if(child.exitCode===null)child.kill('SIGKILL');}processes.delete(kind);}
async function register(context,number,name,accountPin){const result=await kgs(context,'/api/login',{code,attendanceNumber:number,accountPin,register:true});await kgs(context,'/api/profile',{name});return result.member;}
function book(name){return require(path.join(root,'data',name+'.json'));}
function correctChoice(question,bookName,direction){const entry=book(bookName)[question.number-1];eq(question.prompt,entry[direction==='english'?'japanese':'english'],'Question uses its actual numbered material');eq(question.choices.length,4);eq(new Set(question.choices.map(c=>c.id)).size,4);eq(new Set(question.choices.map(c=>c.text.normalize('NFKC').trim().toLowerCase())).size,4,'Every displayed choice is unique');const choice=question.choices.find(c=>c.text===entry[direction==='english'?'english':'japanese']);ok(choice,'One option contains the authoritative answer');return choice;}
async function begin(context,bookName='target1900',direction='english',from=1,to=20){return target(context,'/api/quiz/start',{book:bookName,direction,count:10,from,to,requestId:uuid()});}
async function submit(context,quiz,question,choice,requestId=uuid()){return target(context,'/api/quiz/answer',{quizId:quiz.quizId,questionId:question.id,choiceId:choice.id,requestId});}
async function layout(page,width,label){await page.setViewportSize({width,height:900});ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),label+' has no horizontal overflow at '+width);await page.screenshot({path:path.join(reportDir,label+'-'+width+'.png'),fullPage:true});}
async function openPage(context){const page=await context.newPage();page.on('pageerror',error=>runtimeErrors.push(error.message));await page.goto(targetBase,{waitUntil:'networkidle'});return page;}

(async()=>{let failure;try{
  await fs.mkdir(reportDir,{recursive:true});
  const kgsMigrations=path.resolve(kgsRoot,'../../supabase/migrations');
  ok((await fs.readdir(kgsMigrations)).some(name=>/target.*identity|target.*session/.test(name)),'The actual bridge migration exists');
  await freshDatabase(kgsDatabase,kgsMigrations);await freshDatabase(targetDatabase,path.join(root,'supabase/migrations'));
  await targetDb.query("INSERT INTO target_private.server_credentials(singleton,key_hash) VALUES(true,encode(sha256(convert_to($1,'UTF8')),'hex')) ON CONFLICT(singleton) DO UPDATE SET key_hash=excluded.key_hash",[rpcSecret]);
  execFileSync(process.execPath,['build.cjs'],{cwd:kgsRoot,env:{...process.env,KGS_SPECIAL99_PROVISION_REQUEST:''},stdio:'pipe'});
  execFileSync(process.execPath,['scripts/build.cjs'],{cwd:root,stdio:'pipe'});
  await start('kgs');await start('target');browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  Admin=await makeContext();KgsA=await makeContext();KgsB=await makeContext();A=await makeContext();B=await makeContext();Guest=await makeContext();
  await kgs(Admin,'/api/admin/login',{secret:process.env.KGS_ADMIN_SECRET});await kgs(Admin,'/api/admin/code',{code});
  memberA=await register(KgsA,1,'練習する人A',pinA);memberB=await register(KgsB,2,'練習する人B',pinB);

  await scenario('KGS bridge limits identity disclosure and rejects class-session reuse',async()=>{
    await kgs(Guest,'/api/integrations/target/login',{attendanceNumber:1,accountPin:pinA,attemptId:opaque()},404);
    const linked=await bridge(Guest,'login',{attendanceNumber:1,accountPin:pinA,attemptId:opaque()});remember(linked.token);
    eq(Object.keys(linked).sort(),['token','expiresAt','member'].sort());eq(Object.keys(linked.member).sort(),['id','name']);eq(linked.member.id,memberA.id);eq(linked.member.name,'練習する人A');
    ok(Number.isFinite(new Date(linked.expiresAt).getTime()),'Scoped token has a real expiry');
    await kgs(Guest,'/api/state',undefined,401,{Cookie:'kgs_session='+linked.token});
    const verified=await bridge(Guest,'verify',{token:linked.token});eq(verified.member,linked.member);
    await bridge(Guest,'login',{attendanceNumber:3,accountPin:pinA,attemptId:opaque()},401);
    await bridge(Guest,'login',{attendanceNumber:1,accountPin:pinA,attemptId:opaque(),register:true},400);
    eq((await kgsDb.query('SELECT count(*)::int AS n FROM kgs.members WHERE attendance_number=3')).rows[0].n,0,'Identity linking never creates a class account');
    await bridge(Guest,'logout',{token:linked.token});await bridge(Guest,'verify',{token:linked.token},401);eq((await classSession(KgsA)).member.id,memberA.id,'Target logout cannot log a member out of the class app');
  });

  await scenario('Target guest access, input validation and missing configuration fail safely',async()=>{
    const session=await target(Guest,'/api/session');eq(session.member,null);eq(session.correctCount,0);eq((await target(Guest,'/api/ranking')).ranking,[]);
    await target(Guest,'/api/quiz/start',{book:'target1900',direction:'english',count:10,from:1,to:10,requestId:uuid()},401);
    await target(Guest,'/api/login',{attendanceNumber:1,accountPin:pinA},403,{Origin:'https://unrelated.invalid'});
    await target(Guest,'/api/login',{attendanceNumber:1,accountPin:pinWrong},401);
    await target(Guest,'/api/login',{attendanceNumber:41,accountPin:pinWrong},400);
    await start('broken');await request(Guest,brokenBase,'/api/session',undefined,503);await stop('broken');
    const c=await targetDb.connect();try{await c.query('BEGIN');await c.query('SET LOCAL ROLE anon');let refused=false;try{await c.query('SELECT * FROM target_private.server_credentials');}catch(error){refused=error.code==='42501';}ok(refused,'Public database role cannot read private credentials');await c.query('ROLLBACK');}finally{c.release();}
  });

  await scenario('PIN-only linking enforces a persistent daily bound without blocking ordinary class login',async()=>{
    const Rate=await makeContext();await register(Rate,4,'制限確認の人',pinRate);
    const rateHash=key=>crypto.createHmac('sha256',process.env.KGS_SESSION_SECRET).update('rate'+String.fromCharCode(0)+key).digest('hex');
    const daily=rateHash('target:login:account-day:4'),other=rateHash('target:login:account-day:5'),shared=rateHash('account:4');
    await kgsDb.query("INSERT INTO kgs.access_attempts(identifier_hash,bucket,attempt_count,expires_at) VALUES($1,0,10,now()+interval '2 days')",[daily]);
    await bridge(Rate,'login',{attendanceNumber:4,accountPin:pinRate,attemptId:opaque()},429);
    eq((await kgsDb.query('SELECT attempt_count FROM kgs.access_attempts WHERE identifier_hash=$1',[daily])).rows[0].attempt_count,11,'The refusal persists beyond process memory');
    await kgs(Rate,'/api/login',{code,attendanceNumber:4,accountPin:pinRate});
    ok((await kgsDb.query('SELECT 1 FROM kgs.access_attempts WHERE identifier_hash=$1',[daily])).rowCount===1,'Ordinary class login does not clear the Target daily restriction');
    await kgsDb.query("UPDATE kgs.access_attempts SET attempt_count=1 WHERE identifier_hash=$1",[daily]);
    await kgsDb.query("INSERT INTO kgs.access_attempts(identifier_hash,bucket,attempt_count,expires_at) VALUES($1,0,3,now()+interval '2 days')",[other]);
    const linked=await bridge(Rate,'login',{attendanceNumber:4,accountPin:pinRate,attemptId:opaque()});remember(linked.token);
    eq((await kgsDb.query('SELECT count(*)::int AS n FROM kgs.access_attempts WHERE identifier_hash=ANY($1::text[])',[[daily,shared]])).rows[0].n,0,'Successful same-account PIN proof clears only its own limits');
    eq((await kgsDb.query('SELECT attempt_count FROM kgs.access_attempts WHERE identifier_hash=$1',[other])).rows[0].attempt_count,3);
    await bridge(Rate,'logout',{token:linked.token});await Rate.close();
  });

  await scenario('The already-provisioned special99 identity links without enabling registration',async()=>{
    const specialId=uuid(),salt=crypto.randomBytes(16).toString('hex');
    const {hashAccountPin}=require(path.join(kgsRoot,'server/account-pin.cjs'));
    const digest=await hashAccountPin(pinSpecial,salt,process.env.KGS_SESSION_SECRET);
    const client=await kgsDb.connect();try{await client.query('BEGIN');await client.query("SET LOCAL kgs.special_attendance_admin='on'");await client.query("INSERT INTO kgs.members(id,name,role,attendance_number,attendance_exception,account_pin_salt,account_pin_hash) VALUES($1,'例外の練習者','member',99,true,$2,$3)",[specialId,salt,digest]);await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    const Special=await makeContext();eq((await target(Special,'/api/login',{attendanceNumber:99,accountPin:pinSpecial})).member,{name:'例外の練習者'});eq((await target(Special,'/api/session')).correctCount,0);await target(Special,'/api/logout',{});await Special.close();
    eq((await target(Guest,'/api/ranking')).ranking,[],'Logging in alone does not publish the KGS roster');
  });

  await scenario('Both memorization books show ten items and preserve final-page boundaries on phones',async()=>{
    const page=await openPage(Guest);
    for(const [bookName,total] of [['target1900',1900],['target1000',1000]]){
      await page.locator('[data-book="'+bookName+'"]').click();await page.locator('#memorizeOpen').click();await page.locator('#memorySheet .memory-row').first().waitFor();
      eq(await page.locator('#memorySheet .memory-row').count(),10,'Ten actual entries per page');
      ok((await page.locator('#memorySheet').innerText()).includes(book(bookName)[0].english),'Page begins with the first source entry');
      await page.locator('#memoryNext').click();ok((await page.locator('#memorySheet').innerText()).includes(book(bookName)[10].english),'Next advances to entries11–20');
      await page.locator('#memoryPrevious').click();await page.locator('#memoryPage').selectOption({value:String(total/10-1)});
      eq(await page.locator('#memorySheet .memory-row').count(),10);eq(await page.locator('#memorySheet .memory-word').last().textContent(),book(bookName).at(-1).english,'Final numbered entry is present: '+bookName+' / '+await page.locator('#memoryPage').inputValue()+' / '+await page.locator('#memorizeRange').innerText());
      await page.locator('#memorySheet .memory-word').first().click();eq(await page.locator('#memoryPage').inputValue(),String(total/10-1),'Tapping the last page cannot run beyond the source');
      for(const width of [320,375,390,430,1280])await layout(page,width,'memory-'+bookName);
      await page.locator('#brandHome').click();
    }
    await page.close();
  });

  await scenario('Guest four-choice practice works in both directions without submitting a shared score',async()=>{
    const page=await openPage(Guest),scored=[];page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/quiz/'))scored.push(r.url());});
    for(const direction of ['english','japanese']){
      await page.locator('[data-book="target1000"]').click();await page.locator('#testOpen').click();await page.locator('input[name="direction"][value="'+direction+'"]').check();await page.locator('#rangeFrom').fill('1');await page.locator('#rangeTo').fill('10');await page.locator('#testStart').click();
      for(let i=0;i<10;i++){await page.locator('#questionChoices button').first().waitFor();eq(await page.locator('#questionChoices button').count(),4);eq(new Set(await page.locator('#questionChoices button').allTextContents()).size,4);await page.locator('#questionChoices button').first().click();await page.locator('#answerFeedback').waitFor({state:'visible'});await page.locator('#quizNext').click();}
      await page.locator('#resultView').waitFor({state:'visible'});ok((await page.locator('#resultMode').innerText()).includes('ゲスト'),'Guest results clearly identify their scope');await page.locator('#brandHome').click();
    }
    eq(scored,[],'Intentional guest practice never fabricates cloud scores');eq((await target(Guest,'/api/ranking')).ranking,[]);await page.close();
  });

  await scenario('KGS attendance and PIN login creates only a private Target cookie',async()=>{
    const page=await openPage(A);await page.locator('#settingsOpen').click();await page.locator('#attendanceNumber').fill('1');await page.locator('#accountPin').fill(pinA);
    await page.locator('#pinVisibility').click();eq(await page.locator('#accountPin').getAttribute('type'),'text');await page.locator('#pinVisibility').click();eq(await page.locator('#accountPin').getAttribute('type'),'password');
    const signed=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/login');await page.locator('#loginButton').click();eq((await signed).status(),200);await page.locator('#identityName').waitFor({state:'visible'});
    eq(await page.locator('#accountPin').inputValue(),'');const session=await target(A,'/api/session');eq(session.member,{name:'練習する人A'});eq(session.correctCount,0);
    const cookies=await A.cookies(targetBase);ok(cookies.some(c=>c.httpOnly&&c.sameSite==='Strict'),'Target session is HttpOnly and SameSite Strict');
    const storage=await page.evaluate(()=>JSON.stringify({local:Object.fromEntries(Object.entries(localStorage)),session:Object.fromEntries(Object.entries(sessionStorage)),cookies:document.cookie}));for(const value of [pinA,integrationSecret,rpcSecret,cookieSecret])ok(!storage.includes(value),'No login credential lives in browser-readable storage');
    await page.close();await target(B,'/api/login',{attendanceNumber:2,accountPin:pinB});
  });

  await scenario('Authoritative grading and concurrent answer retries award one score only',async()=>{
    const quiz=await begin(A,'target1900','english',1,10),question=quiz.question,choice=correctChoice(question,'target1900','english'),requestId=uuid();
    const [first,second]=await Promise.all([submit(A,quiz,question,choice,requestId),submit(A,quiz,question,choice,requestId)]);eq(first,second,'Retry returns the same accepted outcome');eq(first.correct,true);eq(first.correctCount,1);eq(first.answeredCount,1);eq((await target(A,'/api/session')).correctCount,1);
    await target(A,'/api/quiz/answer',{quizId:quiz.quizId,questionId:question.id,choiceId:question.choices.find(c=>c.id!==choice.id).id,requestId:uuid()},409);
    let result=first;for(let n=1;n<10;n++){const next=result.nextQuestion;ok(next,'Next question is issued after the accepted answer');const option=correctChoice(next,'target1900','english');result=await submit(A,quiz,next,option);eq(result.correct,true);}
    eq(result.finished,true);eq(result.nextQuestion,null);eq(result.correctCount,10);eq((await target(A,'/api/session')).correctCount,10);
  });

  await scenario('Reverse-direction idioms grade a wrong answer without increasing the total',async()=>{
    const quiz=await begin(A,'target1000','japanese',1,10),correct=correctChoice(quiz.question,'target1000','japanese');const wrong=quiz.question.choices.find(c=>c.id!==correct.id);const result=await submit(A,quiz,quiz.question,wrong);eq(result.correct,false);eq(result.correctChoiceId,correct.id);eq(result.correctText,correct.text);eq(result.correctCount,0);eq((await target(A,'/api/session')).correctCount,10);
    await target(B,'/api/quiz/answer',{quizId:quiz.quizId,questionId:result.nextQuestion.id,choiceId:result.nextQuestion.choices[0].id,requestId:uuid()},404);
    await target(A,'/api/quiz/start',{book:'target1000',direction:'japanese',count:10,from:1,to:10,requestId:uuid(),correctCount:1000},400);
  });

  await scenario('Independent clients share a names-only ranking with stable account ownership',async()=>{
    const quiz=await begin(B,'target1000','english',21,30),answer=correctChoice(quiz.question,'target1000','english');await submit(B,quiz,quiz.question,answer);
    const ranking=(await target(Guest,'/api/ranking')).ranking;eq(ranking.map(r=>r.correctCount),[10,1]);eq(ranking.map(r=>r.name),['練習する人A','練習する人B']);for(const row of ranking)eq(Object.keys(row).sort(),['rank','name','correctCount'].sort());ok(!JSON.stringify(ranking).includes(memberA.id)&&!JSON.stringify(ranking).includes(memberB.id),'Stable member IDs never appear in the public ranking');
    const another=await makeContext();await target(another,'/api/login',{attendanceNumber:1,accountPin:pinA});eq((await target(another,'/api/session')).correctCount,10,'The same account retains its score on another device');
    await kgs(KgsA,'/api/profile',{name:'名前を変えた人A'});eq((await target(A,'/api/session')).member,{name:'名前を変えた人A'});eq((await target(Guest,'/api/ranking')).ranking.map(r=>r.name),['名前を変えた人A','練習する人B']);await another.close();
  });

  await scenario('Scores and sessions survive a Target HTTP server restart',async()=>{
    await stop('target');await start('target');eq((await target(A,'/api/session')).correctCount,10);eq((await target(B,'/api/session')).correctCount,1);eq((await target(Guest,'/api/ranking')).ranking.map(r=>r.correctCount),[10,1]);
  });

  await scenario('A dropped answer request keeps the selected answer for one real retry',async()=>{
    const page=await openPage(A);await page.locator('#testOpen').click();await page.locator('#testStart').click();await page.locator('#questionChoices button').first().waitFor();
    const number=Number((await page.locator('#questionNumber').innerText()).match(/No\. (\d+)/)[1]);
    const correct=book('target1900')[number-1].english,choices=await page.locator('#questionChoices .choice-text').allTextContents(),wrong=choices.findIndex(text=>text!==correct);
    const before=Number((await targetDb.query('SELECT count(*)::int AS n FROM target_private.answers')).rows[0].n),requests=[];
    let failNext=true;await page.route('**/api/quiz/answer',async route=>{requests.push(JSON.parse(route.request().postData()));if(failNext){failNext=false;await route.abort('failed');}else await route.continue();});
    const prompt=await page.locator('#questionPrompt').innerText();await page.locator('#questionChoices button').nth(wrong).click();await page.locator('#answerRetry').waitFor({state:'visible'});
    eq(await page.locator('#questionPrompt').innerText(),prompt,'A failed transmission cannot advance the question');
    eq(Number((await targetDb.query('SELECT count(*)::int AS n FROM target_private.answers')).rows[0].n),before,'The aborted request has not awarded a score');
    await page.locator('#answerRetry').click();await page.locator('#answerFeedback').waitFor({state:'visible'});eq(await page.locator('#feedbackTitle').innerText(),'不正解');eq(requests.length,2);eq(requests[0],requests[1],'Retry reuses the exact answer and request ID');
    eq(Number((await targetDb.query('SELECT count(*)::int AS n FROM target_private.answers')).rows[0].n),before+1);eq((await target(A,'/api/session')).correctCount,10);await page.close();
  });

  await scenario('KGS PIN changes and shared-code rotation invalidate scoped Target sessions',async()=>{
    await kgs(KgsA,'/api/profile',{accountPin:pinNew,currentAccountPin:pinA,requestId:uuid()});eq((await target(A,'/api/session')).member,null);await target(A,'/api/login',{attendanceNumber:1,accountPin:pinA},401);await target(A,'/api/login',{attendanceNumber:1,accountPin:pinNew});eq((await target(A,'/api/session')).correctCount,10);
    await kgs(Admin,'/api/admin/login',{secret:process.env.KGS_ADMIN_SECRET});await kgs(Admin,'/api/admin/code',{code:codeChanged});eq((await target(A,'/api/session')).member,null);eq((await target(B,'/api/session')).member,null);await target(A,'/api/login',{attendanceNumber:1,accountPin:pinNew});await target(B,'/api/login',{attendanceNumber:2,accountPin:pinB});
  });

  await scenario('A class administrator ban blocks the linked Target identity and login',async()=>{
    await kgs(Admin,'/api/admin/login',{secret:process.env.KGS_ADMIN_SECRET});await kgs(Admin,'/api/admin/revoke',{memberId:memberB.id});eq((await target(B,'/api/session')).member,null);await target(B,'/api/login',{attendanceNumber:2,accountPin:pinB},401);eq((await target(A,'/api/session')).correctCount,10,'An unrelated member remains authenticated');
  });

  await scenario('Logged-in quiz and ranking layouts remain usable at all requested widths',async()=>{
    const page=await openPage(A);for(const width of [320,375,390,430,1280])await layout(page,width,'home');await page.locator('#rankingOpen').click();await page.locator('#rankingList').waitFor();for(const width of [320,375,390,430,1280])await layout(page,width,'ranking');await page.locator('#brandHome').click();await page.locator('#testOpen').click();await page.locator('#testStart').click();await page.locator('#questionChoices button').first().waitFor();for(const width of [320,375,390,430,1280])await layout(page,width,'quiz');await page.close();
  });

  await scenario('Target logout and production asset boundaries keep class credentials private',async()=>{
    await kgs(KgsA,'/api/login',{code:codeChanged,attendanceNumber:1,accountPin:pinNew});await target(A,'/api/logout',{});eq((await target(A,'/api/session')).member,null);eq((await classSession(KgsA)).member.id,memberA.id);
    for(const filename of ['index.html','app.js','style.css']){const content=await fs.readFile(path.join(root,'dist',filename),'utf8');for(const secret of [integrationSecret,rpcSecret,cookieSecret,process.env.KGS_ADMIN_SECRET,process.env.KGS_SESSION_SECRET])ok(!content.includes(secret),'Production browser files contain no server secret');}
    const scriptResponse=await Guest.request.get(targetBase+'/server/router.cjs');eq(scriptResponse.status(),404,'Server sources are not static assets');eq(runtimeErrors,[],'Browser has no uncaught errors');
    for(const logs of serverLogs.values())for(const secret of secretSet)ok(!logs.includes(secret),'Runtime logs contain no credential');
  });
}catch(error){failure=error;console.error('E2E ERROR '+redact(error.stack));if(!results.some(r=>r.status==='failed'))results.push({name:'Setup',status:'failed',error:redact(error.message).split('\n')[0]});}
finally{await browser?.close().catch(()=>{});for(const key of [...processes.keys()])await stop(key);await kgsDb.end();await targetDb.end();const report={generatedAt:new Date().toISOString(),environment:'fresh loopback PostgreSQL databases, actual KGS and Target HTTP servers, independent Chromium contexts',cloudVerified:false,physicalSafariVerified:false,externalPushRequests:0,passed:results.filter(r=>r.status==='passed').length,failed:results.filter(r=>r.status==='failed').length,checks,results};await fs.mkdir(reportDir,{recursive:true});await fs.writeFile(path.join(reportDir,'e2e-results.json'),JSON.stringify(report,null,2)+'\n');console.log(`${report.passed} Target scenarios passed; ${report.failed} failed; ${checks} assertions.`);if(failure)process.exitCode=1;}
})();
