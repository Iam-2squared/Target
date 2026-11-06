'use strict';
// Two actual HTTP apps, durable loopback PostgreSQL and independent identities.
// Never load cloud credentials or connect this suite to a hosted database.
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process'),{once}=require('node:events');
const {Client,Pool}=require('pg'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),kgsRoot=process.env.TARGET_KGS_SOURCE_ROOT||path.resolve(root,'../KGS01-stamp-inventory/prototype/v2');
const targetBase='http://127.0.0.1:3240',kgsBase='http://127.0.0.1:3241';
const source=new URL(process.env.DATABASE_URL||'');
assert.equal(process.env.NODE_ENV,'test');assert(['localhost','127.0.0.1','[::1]'].includes(source.hostname),'Loopback test databases are required.');
const targetURL=new URL(source.href),kgsURL=new URL(source.href);targetURL.pathname='/target_bonus_test';kgsURL.pathname='/kgs01_bonus_test';
const targetDb=new Pool({connectionString:targetURL.href}),kgsDb=new Pool({connectionString:kgsURL.href});
const uuid=()=>crypto.randomUUID(),opaque=()=>crypto.randomBytes(32).toString('base64url'),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const secrets=new Set([process.env.KGS_ADMIN_SECRET,process.env.KGS_SESSION_SECRET].filter(Boolean)),secret=value=>{secrets.add(value);return value;};
const integrationSecret=secret(opaque()),rpcSecret=secret(opaque()),cookieSecret=secret(opaque()),code=secret(crypto.randomInt(0,1000000).toString().padStart(6,'0'));
const pins=Array.from({length:5},()=>secret(crypto.randomInt(1000,9999).toString()));
const redact=value=>{let text=String(value);for(const s of secrets)text=text.split(s).join('[credential]');return text;};
const reportDir=path.join(root,'test-results'),processes=new Map(),logs=new Map(),contexts=[],results=[],errors=[];
let browser,checks=0,failure,storageDir,originalOdds,initialA,firstRequest,firstReply,nativeReport=null;
const ok=(value,label)=>{checks++;assert(value,label);},eq=(a,b,label)=>{checks++;assert.deepEqual(a,b,label);};
async function scenario(name,fn){const began=Date.now();try{await fn();results.push({name,status:'passed',durationMs:Date.now()-began});console.log('PASS '+name);}catch(error){results.push({name,status:'failed',error:redact(error.message).split('\n')[0]});throw error;}}
async function context(options={}){const c=await browser.newContext({viewport:{width:390,height:844},...options});contexts.push(c);return c;}
async function request(c,base,route,body,status=200,headers={}){
  const r=await c.request.fetch(base+route,{method:body===undefined?'GET':'POST',headers:{Origin:base,'Content-Type':'application/json',...headers},...(body===undefined?{}:{data:body}),timeout:25000});
  const data=await r.json();eq(r.status(),status,route+' '+(data.error?.code||'ok'));
  ok(/no-store/.test(r.headers()['cache-control']||''),'Private responses are not cached.');
  for(const value of secrets)ok(!JSON.stringify(data).includes(value),'API omits server credentials.');
  Object.defineProperty(data,'__serverNow',{value:Number(r.headers()['x-target-now'])});return data;
}
const target=(c,route,body,status=200,headers={})=>request(c,targetBase,route,body,status,headers);
const kgs=(c,route,body,status=200,headers={})=>request(c,kgsBase,route,body,status,headers);
async function fresh(url,folder){const adminURL=new URL(source.href);adminURL.pathname='/postgres';const admin=new Client({connectionString:adminURL.href});await admin.connect();try{await admin.query('DROP DATABASE IF EXISTS "'+url.pathname.slice(1)+'" WITH (FORCE)');await admin.query('CREATE DATABASE "'+url.pathname.slice(1)+'"');}finally{await admin.end();}const client=new Client({connectionString:url.href});await client.connect();try{for(const name of(await fs.readdir(folder)).filter(n=>/^\d+_.*\.sql$/.test(n)).sort()){await client.query('BEGIN');try{await client.query(await fs.readFile(path.join(folder,name),'utf8'));await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}}}finally{await client.end();}}
function environment(kind){const common={...process.env,NODE_ENV:'test',VERCEL:'',KGS_TARGET_INTEGRATION_SECRET:integrationSecret,KGS_SPECIAL99_PROVISION_REQUEST:'',KGS_ATTENDANCE_PROVISION_REQUEST:'',KGS_PUSH_PUBLIC_KEY:'',KGS_PUSH_PRIVATE_KEY:'',KGS_PUSH_CRON_SECRET:'',KGS_PUSH_SUBJECT:''};return kind==='kgs'?{...common,DATABASE_URL:kgsURL.href,KGS_ALLOWED_ORIGINS:kgsBase,KGS_TARGET_APP_URL:targetBase,KGS_STORAGE_DRIVER:'local',KGS_LOCAL_STORAGE_DIR:storageDir,PORT:'3241'}:{...common,TARGET_DATABASE_URL:targetURL.href,TARGET_RPC_SECRET:rpcSecret,TARGET_COOKIE_SECRET:cookieSecret,KGS_IDENTITY_URL:kgsBase,TARGET_ALLOWED_ORIGINS:targetBase,PORT:'3240'};}
async function start(kind){const cwd=kind==='kgs'?kgsRoot:root,entry=kind==='kgs'?'server/dev.cjs':'scripts/dev.cjs';const p=spawn(process.execPath,[path.join(cwd,entry)],{cwd,env:environment(kind),stdio:['ignore','pipe','pipe']});processes.set(kind,p);logs.set(kind,'');for(const stream of[p.stdout,p.stderr])stream.on('data',v=>logs.set(kind,logs.get(kind)+v));for(let n=0;n<100;n++){if(p.exitCode!==null||p.signalCode!==null)throw Error('Synthetic '+kind+' server stopped.');try{const r=await fetch((kind==='kgs'?kgsBase:targetBase)+'/api/session');if([200,401].includes(r.status))return;}catch{}await sleep(100);}throw Error('Local server did not start.');}
async function stop(kind){const p=processes.get(kind);if(p&&p.exitCode===null&&p.signalCode===null){p.kill('SIGTERM');await Promise.race([once(p,'close'),sleep(2500)]);if(p.exitCode===null&&p.signalCode===null){p.kill('SIGKILL');await Promise.race([once(p,'close'),sleep(1000)]);}}processes.delete(kind);}
const data=require('../data/target1900.json');
function correct(question){const result=question.choices.find(c=>c.text===data[question.number-1].english);ok(result,'The test uses the actual material to select an answer.');return result;}
async function begin(c){return target(c,'/api/quiz/start',{book:'target1900',direction:'english',count:10,from:1,to:20,requestId:uuid()});}
const answerInput=(quiz,question,choice)=>({quizId:quiz.quizId,questionId:question.id,choiceId:choice.id,requestId:uuid()});
async function forceAward(amount){assert([100,100000].includes(amount));await targetDb.query('CREATE OR REPLACE FUNCTION target_private.reward_points_for_roll(p_roll integer) RETURNS integer LANGUAGE sql IMMUTABLE STRICT SECURITY INVOKER SET search_path=pg_catalog AS $$ SELECT '+amount+' $$');}
async function register(c,number,name,pin){const r=await kgs(c,'/api/login',{code,attendanceNumber:number,accountPin:pin,register:true});await kgs(c,'/api/profile',{name});return r.member;}
async function login(c,number,pin){const r=await target(c,'/api/login',{attendanceNumber:number,accountPin:pin});ok(Number.isFinite(r.__serverNow)&&Math.abs(r.__serverNow-Date.now())<5000,'Fresh server time accompanies authenticated JSON.');return r;}
async function probe(page,{denyFirstBonus=false}={}){await page.addInitScript(({denyFirstBonus})=>{
  const nativePlay=HTMLMediaElement.prototype.play,nativePause=HTMLMediaElement.prototype.pause,watched=new WeakSet();
  window.__bonusMedia={plays:[],events:[],nodes:[],denied:0};let denied=false;
  const src=n=>{try{return new URL(n.currentSrc||n.src,location.href).pathname;}catch{return '';}};
  HTMLMediaElement.prototype.play=function(...args){const n=this,entry={src:src(n),at:performance.now(),trusted:!!window.event?.isTrusted,phase:window.event?.eventPhase||0,muted:n.muted,volume:n.volume,resolved:false};window.__bonusMedia.plays.push(entry);if(!watched.has(n)){watched.add(n);window.__bonusMedia.nodes.push(n);for(const type of['playing','pause','ended','error','loadedmetadata','timeupdate'])n.addEventListener(type,()=>window.__bonusMedia.events.push({type,src:src(n),at:performance.now(),time:n.currentTime,duration:Number.isFinite(n.duration)?n.duration:null,error:n.error?.code||null}));}
    if(denyFirstBonus&&!denied&&entry.src.endsWith('/audio/bonus-100000.mp3')){denied=true;window.__bonusMedia.denied++;entry.error='NotAllowedError';return Promise.reject(new DOMException('Synthetic denied playback','NotAllowedError'));}
    let promise;try{promise=nativePlay.apply(n,args);}catch(error){entry.error=error.name;throw error;}promise?.then(()=>{entry.resolved=true;entry.duration=n.duration;},error=>{entry.error=error.name;});return promise;};
  HTMLMediaElement.prototype.pause=function(...args){window.__bonusMedia.events.push({type:'pause-call',src:src(this),at:performance.now(),time:this.currentTime,duration:Number.isFinite(this.duration)?this.duration:null});return nativePause.apply(this,args);};
},{denyFirstBonus});}
async function page(c,options={}){const p=await c.newPage();await probe(p,options);p.on('pageerror',e=>errors.push(e.message));await p.goto(targetBase,{waitUntil:'networkidle'});return p;}
const active=p=>p.evaluate(()=>document.documentElement.classList.contains('target-bonus-active'));
const bonusPlays=p=>p.evaluate(()=>window.__bonusMedia.plays.filter(e=>e.src.endsWith('/audio/bonus-100000.mp3')));
async function startUI(p){await p.locator('#testOpen').click();await p.locator('#testStart').click();await p.locator('#questionChoices button').first().waitFor();}
async function choose(p,isCorrect=true){const number=Number((await p.locator('#questionNumber').innerText()).match(/No\. (\d+)/)[1]),texts=await p.locator('#questionChoices .choice-text').allTextContents(),i=texts.findIndex(t=>isCorrect?t===data[number-1].english:t!==data[number-1].english);ok(i>=0,'UI answer comes from the real dataset.');const response=p.waitForResponse(r=>new URL(r.url()).pathname==='/api/quiz/answer');await p.locator('#questionChoices button').nth(i).click();const r=await response;eq(r.status(),200);const result=await r.json();Object.defineProperty(result,'__processingMs',{value:Number(r.headers()['x-target-processing-ms'])});await p.waitForFunction(()=>!document.getElementById('quizAdvanceSurface').hidden);return result;}
async function earlyAdvance(p){const old=await p.locator('#questionPosition').innerText(),surface=p.locator('#quizAdvanceSurface'),r=await surface.boundingBox();await surface.click({position:{x:8,y:r.height-8}});await p.waitForFunction(old=>document.getElementById('questionPosition').textContent!==old,old);}

(async()=>{let Admin,KgsA,KgsB,KgsC,KgsD,A,A2,B,C,D,Guest,memberA,memberB,memberC,memberD,aQuiz,nextA,apiReplyA,profileBefore,uiPage;
try{
  await fs.mkdir(reportDir,{recursive:true});storageDir=await fs.mkdtemp(path.join(os.tmpdir(),'target-bonus-files-'));
  await fresh(kgsURL,path.resolve(kgsRoot,'../../supabase/migrations'));await fresh(targetURL,path.join(root,'supabase/migrations'));
  await targetDb.query("INSERT INTO target_private.server_credentials(singleton,key_hash) VALUES(true,encode(sha256(convert_to($1,'UTF8')),'hex'))",[rpcSecret]);
  await start('kgs');await start('target');browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  Admin=await context();KgsA=await context();KgsB=await context();KgsC=await context();KgsD=await context();A=await context();A2=await context();B=await context();C=await context();D=await context();Guest=await context();
  await kgs(Admin,'/api/admin/login',{secret:process.env.KGS_ADMIN_SECRET});await kgs(Admin,'/api/admin/code',{code});
  memberA=await register(KgsA,1,'特典確認A',pins[0]);memberB=await register(KgsB,2,'特典確認B',pins[1]);memberC=await register(KgsC,3,'音楽確認C',pins[2]);memberD=await register(KgsD,4,'復旧確認D',pins[3]);
  await login(A,1,pins[0]);await login(A2,1,pins[0]);await login(B,2,pins[1]);await login(C,3,pins[2]);await login(D,4,pins[3]);

  await scenario('Actual migrated probabilities, private boundaries and uploaded MP3 are exact',async()=>{
    eq((await targetDb.query('SELECT target_private.reward_points_for_roll(n) AS amount,count(*)::int AS count FROM generate_series(0,99)n GROUP BY amount ORDER BY amount')).rows,[{amount:100,count:82},{amount:1000,count:15},{amount:10000,count:2},{amount:100000,count:1}]);
    eq((await targetDb.query('SELECT n,target_private.reward_points_for_roll(n) AS amount FROM unnest(ARRAY[0,1,2,3,17,18,99,-1,100])n ORDER BY n')).rows,[{n:-1,amount:null},{n:0,amount:100000},{n:1,amount:10000},{n:2,amount:10000},{n:3,amount:1000},{n:17,amount:1000},{n:18,amount:100},{n:99,amount:100},{n:100,amount:null}]);
    originalOdds=(await targetDb.query("SELECT pg_get_functiondef('target_private.reward_points_for_roll(integer)'::regprocedure) AS body")).rows[0].body;
    const r=await Guest.request.get(targetBase+'/audio/bonus-100000.mp3'),bytes=await r.body();eq(r.status(),200);ok(/^audio\/mpeg(?:;|$)/.test(r.headers()['content-type']||''));eq(bytes.length,255562);eq(crypto.createHash('sha256').update(bytes).digest('hex'),'1b7e2ed1b5d2a0b1feca02a201a911b444c796ddb1d7e11f2e09de751eed9fb4');
    await target(Guest,'/api/quiz/start',{book:'target1900',direction:'english',count:10,from:1,to:10,requestId:uuid()},401);
    await target(A,'/api/quiz/answer',{quizId:uuid(),questionId:uuid(),choiceId:uuid(),requestId:uuid(),bonusEndsAt:new Date(Date.now()+3600000).toISOString()},400);
    eq((await target(Guest,'/api/session')).bonus??null,null,'Guests receive no server purchasing bonus.');
  });

  await scenario('A real 100,000 answer creates one persistent member window and replay never extends it',async()=>{
    await forceAward(100000);aQuiz=await begin(A);initialA=aQuiz;eq(aQuiz.bonus??null,null);firstRequest=answerInput(aQuiz,aQuiz.question,correct(aQuiz.question));firstReply=await target(A,'/api/quiz/answer',firstRequest);eq(firstReply.awardPoints,100000);eq(firstReply.totalPoints,100000);
    ok(/^[a-f0-9-]{36}$/i.test(firstReply.bonus.id));eq(firstReply.bonus.durationMs,15900);eq(Date.parse(firstReply.bonus.endsAt)-Date.parse(firstReply.bonus.startedAt),15900);ok(Math.abs(Date.parse(firstReply.bonus.startedAt)-firstReply.__serverNow)<1500,'Bonus expiry is grounded in fresh server time.');
    await sleep(80);const retry=await target(A2,'/api/quiz/answer',firstRequest);eq(retry,firstReply,'Stored answer JSON remains a stable receipt.');ok(retry.__serverNow>firstReply.__serverNow,'Replay timing header is fresh while its receipt stays stable.');eq((await target(A2,'/api/session')).bonus,firstReply.bonus,'A second device sees the same absolute window.');
    const alternate=await target(A,'/api/quiz/answer',{...firstRequest,requestId:uuid()});eq(alternate,firstReply);nextA=firstReply.nextQuestion;
  });

  await scenario('Concurrent quizzes share 500 rewards while another member has an independent window',async()=>{
    const secondQuiz=await begin(A2);eq(secondQuiz.bonus,firstReply.bonus);const x=answerInput(aQuiz,nextA,correct(nextA)),y=answerInput(secondQuiz,secondQuiz.question,correct(secondQuiz.question));
    const values=await Promise.all([target(A,'/api/quiz/answer',x),target(A2,'/api/quiz/answer',y)]);for(const v of values){eq(v.awardPoints,500);eq(v.bonus,firstReply.bonus);}eq((await target(A,'/api/session')).totalIncome,101000);
    const wrong=values[0].nextQuestion,wrongChoice=wrong.choices.find(c=>c.id!==correct(wrong).id);apiReplyA=await target(A,'/api/quiz/answer',answerInput(aQuiz,wrong,wrongChoice));eq(apiReplyA.awardPoints,0);eq(apiReplyA.bonus,firstReply.bonus);
    const q=await begin(B),b=await target(B,'/api/quiz/answer',answerInput(q,q.question,correct(q.question)));eq(b.awardPoints,100000);ok(b.bonus.id!==firstReply.bonus.id,'Different accounts have separate bonus IDs.');
    const purchase=await kgs(KgsA,'/api/shop/gacha',{requestId:uuid(),expectedPrice:100000});eq(purchase.totalIncome,101000);eq(purchase.spent,100000);eq(purchase.balance,1000,'Study rewards remain spendable at the acknowledged100k price without reducing gross income.');
  });

  await scenario('Native 100,000 music continues through automatic and early advances, then expires near the full clip',async()=>{
    uiPage=await page(C);await startUI(uiPage);const blocker=await targetDb.connect();await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock(991101)');
    const arrived=uiPage.waitForRequest(r=>new URL(r.url()).pathname==='/api/quiz/answer'),queued=choose(uiPage);
    try{await arrived;await sleep(950);}finally{await blocker.query('COMMIT');blocker.release();}
    const r=await queued;eq(r.awardPoints,100000);ok(r.__processingMs>=850,'Fresh timing measures actual authentication/DB processing before award.');await uiPage.waitForFunction(()=>document.documentElement.classList.contains('target-bonus-active'));
    if(await uiPage.locator('#bonusAudioResume').isVisible())await uiPage.locator('#bonusAudioResume').click();
    await uiPage.waitForFunction(()=>window.__bonusMedia.plays.some(p=>p.src.endsWith('/audio/bonus-100000.mp3')&&p.resolved)&&window.__bonusMedia.nodes.some(n=>n.src.endsWith('/audio/bonus-100000.mp3')&&!n.paused&&n.currentTime>.1),null,{timeout:5000});
    const firstPlay=(await bonusPlays(uiPage)).find(p=>p.resolved);ok(firstPlay.duration>15.7&&firstPlay.duration<16.1,'Native decoder accepts the uploaded full clip.');ok(!firstPlay.muted&&firstPlay.volume>0);
    const initialAudioTime=await uiPage.evaluate(()=>window.__bonusMedia.events.find(e=>e.src.endsWith('/audio/bonus-100000.mp3')&&e.type==='playing')?.time);ok(initialAudioTime>=0&&initialAudioTime<.35,'The pre-award DB queue does not skip the music intro.');
    const initialPosition='1 / 10問';await uiPage.waitForFunction(old=>document.getElementById('questionPosition').textContent!==old,initialPosition,{timeout:2500});
    ok(await uiPage.evaluate(()=>window.__bonusMedia.nodes.some(n=>n.src.endsWith('/audio/bonus-100000.mp3')&&!n.paused&&n.currentTime>.7)),'One-second question advance leaves bonus music playing.');
    const two=await choose(uiPage);eq(two.awardPoints,500);await earlyAdvance(uiPage);ok(await active(uiPage));ok(await uiPage.evaluate(()=>window.__bonusMedia.nodes.some(n=>n.src.endsWith('/audio/bonus-100000.mp3')&&!n.paused&&n.currentTime>1)),'An optional tap does not stop the track.');
    await forceAward(100);const count=(await bonusPlays(uiPage)).length;await uiPage.evaluate(()=>{const real=Date.now;Date.now=()=>real()-3600000;});
    await uiPage.waitForFunction(()=>!document.documentElement.classList.contains('target-bonus-active'),null,{timeout:20000});
    const rewardExpiredAt=await uiPage.evaluate(()=>performance.now());
    const normal=await choose(uiPage);eq(normal.awardPoints,100);eq(normal.bonus??null,null,'Server expiry immediately restores ordinary rewards, even while a quiet tail finishes.');ok(!await active(uiPage),'Finishing the audio never extends the500 reward state.');
    await uiPage.waitForFunction(()=>window.__bonusMedia.events.some(e=>e.src.endsWith('/audio/bonus-100000.mp3')&&e.type==='ended'),null,{timeout:1000});
    nativeReport=await uiPage.evaluate(rewardExpiredAt=>{const s=window.__bonusMedia,e=s.events.filter(e=>e.src.endsWith('/audio/bonus-100000.mp3')),ended=e.find(e=>e.type==='ended');return{plays:s.plays.filter(p=>p.src.endsWith('/audio/bonus-100000.mp3')).map(({error,resolved,duration})=>({error:error||null,resolved,duration:duration||null})),naturalEnded:!!ended,maxTime:Math.max(0,...e.map(x=>x.time)),duration:e.find(e=>e.duration)?.duration,tailAfterRewardMs:ended?Math.max(0,ended.at-rewardExpiredAt):null,events:e.filter(e=>['playing','ended','pause-call','error'].includes(e.type)),paused:s.nodes.filter(n=>n.src.endsWith('/audio/bonus-100000.mp3')).every(n=>n.paused)};},rewardExpiredAt);
    ok(nativeReport.naturalEnded&&nativeReport.maxTime>=nativeReport.duration-.02,'The full uploaded music actually reaches native ended.');ok(nativeReport.tailAfterRewardMs<=450,'Only a bounded350ms quiet tail plus observation tolerance remains after rewards expire.');ok(nativeReport.paused);eq((await bonusPlays(uiPage)).length,count,'Expiry does not replay the soundtrack.');
    const session=await target(A,'/api/session');eq(session.bonus??null,null);const stale=await target(A2,'/api/quiz/answer',firstRequest);eq(stale,firstReply);ok(stale.__serverNow>Date.parse(stale.bonus.endsAt),'Expired replay retains its old deadline, with a fresh clock header.');
  });

  await scenario('Guest practice, muting, denied autoplay and trusted retry keep one nonextendable bonus',async()=>{
    const guest=await page(Guest,{denyFirstBonus:true});let guestPosts=0;guest.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/quiz/')&&r.method()==='POST')guestPosts++;});await guest.evaluate(()=>{localStorage.setItem('target-sound-enabled','false');});await guest.reload({waitUntil:'networkidle'});
    // The deterministic guest draw is confined to this page; no shared API award is mocked.
    await guest.evaluate(()=>{const native=crypto.getRandomValues.bind(crypto);crypto.getRandomValues=a=>a instanceof Uint32Array&&a.length===1?(a[0]=0,a):native(a);});
    await startUI(guest);const number=Number((await guest.locator('#questionNumber').innerText()).match(/No\. (\d+)/)[1]),texts=await guest.locator('#questionChoices .choice-text').allTextContents(),i=texts.indexOf(data[number-1].english);await guest.locator('#questionChoices button').nth(i).click();await guest.waitForFunction(()=>document.documentElement.classList.contains('target-bonus-active'));eq((await bonusPlays(guest)).length,0,'Muted bonus has no media play call.');
    await guest.locator('#quizQuit').click();await guest.locator('#quitConfirm').click();await guest.locator('#homeView').waitFor();
    await guest.locator('#settingsOpen').click();await guest.locator('#soundSetting').selectOption('on');await guest.waitForFunction(()=>window.__bonusMedia.denied===1);await guest.locator('#settingsClose').click();await guest.locator('#bonusAudioResume').waitFor({state:'visible'});await guest.locator('#bonusAudioResume').click();await guest.waitForFunction(()=>window.__bonusMedia.plays.some(p=>p.src.endsWith('/audio/bonus-100000.mp3')&&p.resolved));
    const resumed=(await bonusPlays(guest)).find(p=>p.resolved);ok(resumed.trusted&&resumed.phase>0,'Fallback calls native play in a real user gesture.');ok(await active(guest));
    await guest.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});ok(await guest.evaluate(()=>window.__bonusMedia.nodes.filter(n=>n.src.endsWith('/audio/bonus-100000.mp3')).every(n=>n.paused)),'Background visibility signal pauses music.');
    await sleep(250);await guest.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});
    await guest.locator('#settingsOpen').click();await guest.locator('#soundSetting').selectOption('off');await guest.locator('#settingsClose').click();ok(await active(guest),'Turning off sound does not remove the timed bonus.');ok(await guest.evaluate(()=>window.__bonusMedia.nodes.filter(n=>n.src.endsWith('/audio/bonus-100000.mp3')).every(n=>n.paused)));
    await startUI(guest);const nextNumber=Number((await guest.locator('#questionNumber').innerText()).match(/No\. (\d+)/)[1]),nextTexts=await guest.locator('#questionChoices .choice-text').allTextContents(),nextIndex=nextTexts.indexOf(data[nextNumber-1].english);ok(nextIndex>=0);await guest.locator('#questionChoices button').nth(nextIndex).click();await guest.waitForFunction(()=>!document.getElementById('quizAdvanceSurface').hidden);eq(Number((await guest.locator('#feedbackReward').innerText()).replace(/[^0-9]/g,'')),500,'Guest bonus correct answers use the same fixed500 reward across a new quiz.');eq(guestPosts,0,'Guest bonus practice never posts shared answers.');
    await guest.close();eq((await target(Guest,'/api/session')).balance,0,'Guest practice never creates purchasing funds.');
  });

  await scenario('Golden framing fits five widths, reduced motion and authenticated reload without re-awarding',async()=>{
    await forceAward(100000);const p=await page(D);await startUI(p);const result=await choose(p);eq(result.awardPoints,100000);await p.waitForFunction(()=>document.documentElement.classList.contains('target-bonus-active'));
    for(const width of[320,375,390,430,1280]){await p.setViewportSize({width,height:844});ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Gold framing has no horizontal overflow at '+width);ok(await p.locator('#bonusTimeBanner').isVisible());ok((await p.locator('#bonusTimeBanner').innerText()).includes('500'));const r=await p.locator('#bonusTimeBanner').boundingBox();ok(r.x>=-1&&r.x+r.width<=width+1,'The bonus banner fits '+width);await p.screenshot({path:path.join(reportDir,'bonus-'+width+'.png'),fullPage:false});}
    await p.emulateMedia({reducedMotion:'reduce'});ok(await active(p));const income=(await target(D,'/api/session')).totalIncome;await p.reload({waitUntil:'networkidle'});await p.waitForFunction(()=>document.documentElement.classList.contains('target-bonus-active'));eq((await target(D,'/api/session')).totalIncome,income,'Reload restores the deadline without a second award.');ok(!await p.locator('#homeView').getAttribute('hidden'));
    await p.locator('#settingsOpen').click();await p.locator('#logoutButton').click();await p.waitForFunction(()=>!document.documentElement.classList.contains('target-bonus-active'));eq(await p.locator('#bonusTimeBanner').isVisible(),false);ok(await p.evaluate(()=>window.__bonusMedia.nodes.filter(n=>n.src.endsWith('/audio/bonus-100000.mp3')).every(n=>n.paused)),'Logout stops the active track.');await p.close();
  });

  await scenario('An accepted but delayed answer cannot restore gold or audio after logout',async()=>{
    const p=await page(A);await startUI(p);let release,arrived;const gate=new Promise(r=>release=r),ready=new Promise(r=>arrived=r);let held=false;
    await p.route('**/api/quiz/answer',async route=>{if(held)return route.continue();held=true;const real=await route.fetch();arrived();await gate;try{await route.fulfill({response:real});}catch{}});
    const number=Number((await p.locator('#questionNumber').innerText()).match(/No\. (\d+)/)[1]),texts=await p.locator('#questionChoices .choice-text').allTextContents(),i=texts.indexOf(data[number-1].english);await p.locator('#questionChoices button').nth(i).click();await ready;
    await p.locator('#quizQuit').click();await p.locator('#quitConfirm').click();await p.locator('#homeView').waitFor();await p.locator('#settingsOpen').click();await p.locator('#logoutButton').click();await p.waitForFunction(()=>document.getElementById('loggedInSettings').hidden);release();await sleep(300);eq(await active(p),false);ok(await p.evaluate(()=>window.__bonusMedia.nodes.filter(n=>n.src.endsWith('/audio/bonus-100000.mp3')).every(n=>n.paused)));await p.close();
    eq(errors,[],'No unhandled runtime errors.');for(const s of secrets)for(const output of logs.values())ok(!output.includes(s),'Runtime credentials are not logged.');
  });
}catch(error){failure=error;if(!results.some(r=>r.status==='failed'))results.push({name:'Bonus suite setup',status:'failed',error:redact(error.message).split('\n')[0]});console.error('FAIL '+redact(error.stack));}
finally{await browser?.close().catch(()=>{});await stop('target');await stop('kgs');if(originalOdds)try{await targetDb.query(originalOdds);}catch{}await Promise.allSettled([targetDb.end(),kgsDb.end()]);if(storageDir)await fs.rm(storageDir,{recursive:true,force:true}).catch(()=>{});const report={generatedAt:new Date().toISOString(),environment:'real loopback KGS and Target HTTP, dedicated PostgreSQL, independent Chromium identities',cloudVerified:false,physicalSafariVerified:false,checks,passed:results.filter(r=>r.status==='passed').length,failed:results.filter(r=>r.status==='failed').length,nativeAudio:nativeReport,results};await fs.mkdir(reportDir,{recursive:true});await fs.writeFile(path.join(reportDir,'bonus-results.json'),JSON.stringify(report,null,2)+'\n');console.log(report.passed+' bonus scenarios passed; '+report.failed+' failed; '+checks+' assertions.');if(failure)process.exitCode=1;}
})().catch(error=>{console.error(redact(error.stack));process.exitCode=1;});
