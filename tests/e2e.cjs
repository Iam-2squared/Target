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
let checks=0,browser,Admin,KgsA,KgsB,A,B,Guest,memberA,memberB,materialFeedbackMs=null,guestHundredPreparationMs=null,pointsA=0,pointsB=0;
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
async function register(context,number,name,accountPin,loginCode=code){const result=await kgs(context,'/api/login',{code:loginCode,attendanceNumber:number,accountPin,register:true});await kgs(context,'/api/profile',{name});return result.member;}
function book(name){return require(path.join(root,'data',name+'.json'));}
function correctChoice(question,bookName,direction){const entry=book(bookName)[question.number-1];eq(question.prompt,entry[direction==='english'?'japanese':'english'],'Question uses its actual numbered material');eq(question.choices.length,4);eq(new Set(question.choices.map(c=>c.id)).size,4);eq(new Set(question.choices.map(c=>c.text.normalize('NFKC').trim().toLowerCase())).size,4,'Every displayed choice is unique');const choice=question.choices.find(c=>c.text===entry[direction==='english'?'english':'japanese']);ok(choice,'One option contains the authoritative answer');return choice;}
async function begin(context,bookName='target1900',direction='english',from=1,to=20,count=10){const result=await target(context,'/api/quiz/start',{book:bookName,direction,count,from,to,requestId:uuid()});eq(result.quizPoints,0,'A new quiz begins with no points');return result;}
async function submit(context,quiz,question,choice,requestId=uuid()){return target(context,'/api/quiz/answer',{quizId:quiz.quizId,questionId:question.id,choiceId:choice.id,requestId});}
async function layout(page,width,label){await page.setViewportSize({width,height:900});ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),label+' has no horizontal overflow at '+width);await page.screenshot({path:path.join(reportDir,label+'-'+width+'.png'),fullPage:true});}
async function mediaProbe(page){await page.addInitScript(()=>{
  window.__audioStarts=[];window.__mediaEvents=[];window.__mediaNodes=[];window.__mediaGestureEvent=null;
  const begin=event=>{window.__mediaGestureEvent=event;};
  for(const name of ['click','change','pointerdown'])document.addEventListener(name,begin,{capture:true});
  const nativePlay=HTMLMediaElement.prototype.play,nativePause=HTMLMediaElement.prototype.pause,watched=new WeakSet();
  window.__nativeMediaPlay=nativePlay;
  HTMLMediaElement.prototype.play=function(...args){
    const node=this,src=node.currentSrc||node.src,entry={src,at:performance.now(),gesture:(window.event||window.__mediaGestureEvent)?.eventPhase>0,eventType:(window.event||window.__mediaGestureEvent)?.type,trusted:(window.event||window.__mediaGestureEvent)?.isTrusted,stack:new Error().stack,active:navigator.userActivation?.isActive,muted:node.muted,volume:node.volume};window.__audioStarts.push(entry);
    if(!watched.has(node)){watched.add(node);window.__mediaNodes.push(node);for(const type of ['playing','ended','pause','error','loadedmetadata'])node.addEventListener(type,()=>window.__mediaEvents.push({type,src:node.currentSrc||node.src,at:performance.now(),time:node.currentTime,duration:Number.isFinite(node.duration)?node.duration:null,error:node.error?.code||null}));}
    let result;try{result=nativePlay.apply(node,args);}catch(error){entry.error=error.name;throw error;}
    if(result?.then)result.then(()=>{entry.resolved=true;entry.time=node.currentTime;entry.duration=node.duration;},error=>{entry.error=error.name;});
    return result;
  };
  HTMLMediaElement.prototype.pause=function(...args){window.__mediaEvents.push({type:'pause-call',src:this.currentSrc||this.src,at:performance.now(),time:this.currentTime});return nativePause.apply(this,args);};
});}
async function openPage(context,{audio=false}={}){const page=await context.newPage();if(audio)await mediaProbe(page);page.on('pageerror',error=>runtimeErrors.push(error.message));await page.goto(targetBase,{waitUntil:'networkidle'});return page;}
function reward(result,quizBefore,lifetimeBefore,correct=result.correct){
  eq(result.correct,correct);ok(Number.isSafeInteger(result.awardPoints),'A reward is an integer');ok(correct?[100,1000,10000].includes(result.awardPoints):result.awardPoints===0,'Only correct answers receive an allowed reward');
  eq(result.quizPoints,quizBefore+result.awardPoints,'The quiz total contains this reward once');eq(result.totalPoints,lifetimeBefore+result.awardPoints,'The lifetime total contains this reward once');
  return result.awardPoints;
}
const displayedPoints=text=>Number(text.replace(/[^0-9]/g,''));
async function waitForResult(page){await page.waitForFunction(()=>{const surface=document.getElementById('quizAdvanceSurface');return surface&&!surface.hidden&&!surface.disabled;});}
async function advanceResult(page){await waitForResult(page);const surface=page.locator('#quizAdvanceSurface'),box=await surface.boundingBox();ok(box,'The acknowledged result has a tappable surface');await surface.click({position:{x:8,y:box.height-8}});}
async function watchResultProgress(page){await page.evaluate(()=>{
  window.__resultPlaybacks=[];const surface=document.getElementById('quizAdvanceSurface'),position=document.getElementById('questionPosition'),result=document.getElementById('resultView');let shown=!surface.hidden,current=null;
  new MutationObserver(()=>{
    const nowShown=!surface.hidden;
    if(nowShown&&!shown){current={shownAt:performance.now(),position:position.textContent,verdict:document.getElementById('feedbackTitle').textContent,amount:Number(document.getElementById('feedbackReward').textContent.replace(/[^0-9]/g,'')),points:Number(document.getElementById('quizPoints').textContent.replace(/[^0-9]/g,''))};window.__resultPlaybacks.push(current);}
    if(!nowShown&&shown&&current)current.hiddenAt=performance.now();shown=nowShown;
    if(current&&current.progressedAt===undefined&&(!result.hidden||position.textContent!==current.position)){current.progressedAt=performance.now();current.elapsed=current.progressedAt-current.shownAt;current.nextPosition=position.textContent;current.finished=!result.hidden;}
  }).observe(document.getElementById('quizView').parentElement,{attributes:true,attributeFilter:['hidden'],childList:true,subtree:true,characterData:true});
});}
async function watchRewards(page){await page.evaluate(()=>{
  window.__rewardObservations=[];const overlay=document.getElementById('rewardCelebration');let visible=!overlay.hidden,current=null;
  new MutationObserver(()=>{
    const nextVisible=!overlay.hidden;if(nextVisible===visible)return;visible=nextVisible;
    if(!visible){if(current&&current.hiddenAt===undefined){current.hiddenAt=performance.now();current.visibleMs=current.hiddenAt-current.shownAt;}return;}
    const reward=document.getElementById('feedbackReward'),choices=document.getElementById('questionChoices'),r=reward.getBoundingClientRect(),c=choices.getBoundingClientRect(),o=overlay.getBoundingClientRect(),card=overlay.querySelector('.reward-card'),style=getComputedStyle(reward);
    const displayed=node=>node&&getComputedStyle(node).display!=='none';
    const advance=document.getElementById('quizAdvanceSurface');
    current={shownAt:performance.now(),tier:overlay.dataset.tier,amount:Number(reward.textContent.replace(/[^0-9]/g,'')),width:innerWidth,font:parseFloat(style.fontSize),opacity:parseFloat(getComputedStyle(overlay).opacity),pointerEvents:getComputedStyle(overlay).pointerEvents,aria:overlay.getAttribute('aria-hidden'),amountFits:r.left>=-1&&r.right<=innerWidth+1,overlap:r.top<c.bottom&&r.bottom>c.top&&r.left<c.right&&r.right>c.left,overlayOverlap:o.top<c.bottom&&o.bottom>c.top,overflow:document.documentElement.scrollWidth>innerWidth+1,advanceReady:!!advance&&!advance.hidden&&!advance.disabled,rain:(()=>{const layer=document.getElementById('jackpotBillRain'),box=layer?.getBoundingClientRect();return{shown:!!layer&&!layer.hidden,count:layer?.querySelectorAll('.target-jackpot-bundle').length||0,pointer:layer?getComputedStyle(layer).pointerEvents:null,aria:layer?.getAttribute('aria-hidden'),position:layer?getComputedStyle(layer).position:null,width:box?.width||0,height:box?.height||0,frames:layer?[...layer.querySelectorAll('.target-jackpot-bundle')].map(note=>({duration:parseFloat(getComputedStyle(note).animationDuration)*1000,frames:note.getAnimations().flatMap(animation=>animation.effect.getKeyframes().map(frame=>frame.transform||''))})):[]};})(),particles:[...overlay.querySelectorAll('.reward-confetti i')].filter(displayed).length,rays:!!displayed(overlay.querySelector('.reward-rays')),rings:[...overlay.querySelectorAll('.reward-ring')].filter(displayed).length,cardDuration:getComputedStyle(card).animationDuration.split(',').map(value=>parseFloat(value)*1000),animations:overlay.getAnimations({subtree:true}).filter(animation=>animation.playState==='running'&&animation.effect?.getComputedTiming().duration>1).length};
    window.__rewardObservations.push(current);
  }).observe(overlay,{attributes:true,attributeFilter:['hidden']});
});}

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

  await scenario('Reward mapping allocates exactly two, fifteen and eighty-three of a hundred outcomes',async()=>{
    const mapped=(await targetDb.query('SELECT target_private.reward_points_for_roll(roll) AS amount,count(*)::int AS outcomes FROM generate_series(0,99) roll GROUP BY amount ORDER BY amount')).rows;
    eq(mapped,[{amount:100,outcomes:83},{amount:1000,outcomes:15},{amount:10000,outcomes:2}],'Each integer roll has precisely the requested probability');
    eq((await targetDb.query('SELECT roll,target_private.reward_points_for_roll(roll) AS amount FROM unnest(ARRAY[0,1,2,16,17,99]) roll ORDER BY roll')).rows,[{roll:0,amount:10000},{roll:1,amount:10000},{roll:2,amount:1000},{roll:16,amount:1000},{roll:17,amount:100},{roll:99,amount:100}],'All new probability boundaries are inclusive and correct');
    const invalid=(await targetDb.query('SELECT target_private.reward_points_for_roll(-1) AS low,target_private.reward_points_for_roll(100) AS high,target_private.reward_points_for_roll(NULL) AS missing')).rows[0];eq(invalid,{low:null,high:null,missing:null});
  });

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
    const session=await target(Guest,'/api/session');eq(session.member,null);eq(session.correctCount,0);eq(session.totalPoints,0);eq((await target(Guest,'/api/ranking')).ranking,[]);
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

  await scenario('Both memorization books fill the available screen and preserve final-page boundaries on phones',async()=>{
    const page=await openPage(Guest);
    for(const [bookName,total] of [['target1900',1900],['target1000',1000]]){
      await page.locator('[data-book="'+bookName+'"]').click();await page.locator('#homeSectionFrom').selectOption('1');await page.locator('#homeSectionTo').selectOption(String(total/100));await page.locator('#memorizeOpen').click();await page.locator('#memorySheet .memory-row').first().waitFor();
      const initialCount=await page.locator('#memorySheet .memory-row').count();ok(initialCount>=1&&initialCount<=total,'The page contains complete entries within the book');
      ok((await page.locator('#memorySheet').innerText()).includes(book(bookName)[0].english),'Page begins with the first source entry');
      const previousLast=Number(await page.locator('#memorySheet .word-number').last().innerText());
      await page.locator('#memoryNext').click();eq(Number(await page.locator('#memorySheet .word-number').first().innerText()),previousLast+1,'Next begins immediately after the previous page without skipping an entry');
      await page.locator('#memoryPrevious').click();const lastPage=String(await page.locator('#memoryPage option').count()-1);await page.locator('#memoryPage').selectOption({value:lastPage});
      const finalCount=await page.locator('#memorySheet .memory-row').count();ok(finalCount>=1&&finalCount<=total);eq(await page.locator('#memorySheet .memory-english').last().textContent(),book(bookName).at(-1).english,'Final numbered entry is present: '+bookName+' / '+await page.locator('#memoryPage').inputValue()+' / '+await page.locator('#memorizeRange').innerText());
      await page.locator('#memorySheet .memory-english').first().click();eq(await page.locator('#memoryPage').inputValue(),lastPage,'Tapping the last page cannot run beyond the source');
      for(const width of [320,375,390,430,1280])await layout(page,width,'memory-'+bookName);
      await page.locator('#memorizeView [data-home]').click();
    }
    await page.close();
  });

  await scenario('Section ranges keep original numbers and fit every requested phone width',async()=>{
    const page=await openPage(Guest);
    for(const [bookName,section,last] of [['target1900',19,1900],['target1000',10,1000]]){
      await page.locator('[data-book="'+bookName+'"]').click();
      eq(await page.locator('#homeSectionFrom option').count(),section);eq(await page.locator('#homeSectionTo option').count(),section);
      await page.locator('#homeSectionFrom').selectOption(String(section));await page.locator('#homeSectionTo').selectOption(String(section));
      await page.locator('#memorizeOpen').click();await page.locator('#memorySheet .memory-row').first().waitFor();
      eq(Number(await page.locator('#memorySheet .word-number').first().innerText()),last-99,'A section starts at its original source number');
      for(const [width,height] of [[320,568],[375,667],[390,844],[430,932],[1280,900]]){
        await page.setViewportSize({width,height});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        const count=await page.locator('#memoryPage option').count();await page.locator('#memoryPage').selectOption({value:String(count-1)});
        eq(Number(await page.locator('#memorySheet .word-number').last().innerText()),last,'The last page ends at selected section: '+bookName+' '+width+'x'+height+' expectedpages='+count+' actualpages='+(await page.locator('#memoryPage option').count())+' selected='+(await page.locator('#memoryPage').inputValue())+' range='+(await page.locator('#memorizeRange').innerText()));
        const numbers=(await page.locator('#memorySheet .word-number').allTextContents()).map(Number);ok(numbers.every(number=>number>=last-99&&number<=last),'No adjacent-section entries are rendered');
        ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1&&document.documentElement.scrollHeight<=innerHeight+1),'Complete words and controls fit without horizontal or vertical scrolling');
      }
      await page.locator('#memorizeView [data-home]').click();
      await page.locator('#homeSectionFrom').selectOption('1');await page.locator('#homeSectionTo').selectOption('5');
      await page.locator('#memorizeOpen').click();await page.locator('#memorySheet .memory-row').first().waitFor();eq(Number(await page.locator('#memorySheet .word-number').first().innerText()),1);
      await page.locator('#memoryPage').selectOption({value:String(await page.locator('#memoryPage option').count()-1)});eq(Number(await page.locator('#memorySheet .word-number').last().innerText()),500);
      await page.locator('#memorizeView [data-home]').click();
    }
    await page.close();
  });

  await scenario('Guest four-choice practice works in both directions without submitting a shared score',async()=>{
    const page=await openPage(Guest),scored=[];page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/quiz/'))scored.push(r.url());});
    for(const [direction,count] of [['english',10],['japanese',10],['english',100],['japanese',50]]){
      await page.locator('[data-book="target1000"]').click();await page.locator('#testOpen').click();await page.locator('input[name="direction"][value="'+direction+'"]').check();await page.locator('#rangeFrom').selectOption('1');await page.locator('#rangeTo').selectOption('1');await page.locator('#questionCount').selectOption(String(count));
      eq(await page.locator('#questionCount option').allTextContents(),['10問','50問','100問']);
      if(count===100)await page.evaluate(()=>{document.getElementById('testStart').addEventListener('click',()=>{const began=performance.now(),observer=new MutationObserver(()=>{if(!document.getElementById('quizView').hidden){window.__guestPrepareMs=performance.now()-began;observer.disconnect();}});observer.observe(document.getElementById('quizView'),{attributes:true,attributeFilter:['hidden']});},{capture:true,once:true});});
      await page.locator('#testStart').click();eq(await page.locator('#questionPosition').innerText(),'1 / '+count+'問');
      if(count===100){guestHundredPreparationMs=await page.evaluate(()=>window.__guestPrepareMs);ok(Number.isFinite(guestHundredPreparationMs),'The real guest100 preparation duration is measured');}
      let guestCorrect=0,guestPoints=0;
      for(let i=0;i<count;i++){
        await page.locator('#questionChoices button').first().waitFor();eq(await page.locator('#questionChoices button').count(),4);eq(new Set(await page.locator('#questionChoices button').allTextContents()).size,4);
        await page.locator('#questionChoices button').first().click();await page.locator('#answerFeedback').waitFor({state:'visible'});
        eq(await page.locator('#questionChoices button').first().getAttribute('aria-pressed'),'true');
        const correct=await page.locator('#feedbackTitle').innerText()==='正解';if(correct){guestCorrect++;const amount=displayedPoints(await page.locator('#feedbackReward').innerText());ok([100,1000,10000].includes(amount),'Guest correct answers use the same virtual reward amounts');guestPoints+=amount;}else ok(!await page.locator('#feedbackReward').isVisible(),'Wrong guest answers give no reward');
        eq(displayedPoints(await page.locator('#quizPoints').innerText()),guestPoints,'Guest quiz points contain each local award once');
        eq(await page.locator('#quizSubmit').count(),0,'Guest practice needs no separate Answer button');await advanceResult(page);
      }
      await page.locator('#resultView').waitFor({state:'visible'});eq(await page.locator('#resultTotal').innerText(),'/ '+count+'問');eq(Number(await page.locator('#resultCorrect').innerText()),guestCorrect);eq(displayedPoints(await page.locator('#resultPoints').innerText()),guestPoints);ok((await page.locator('#resultMode').innerText()).includes('ゲスト'),'Guest results clearly identify their scope');await page.locator('#resultView [data-home]').click();
    }
    eq(scored,[],'Intentional guest practice never fabricates cloud scores');eq((await target(Guest,'/api/ranking')).ranking,[]);await page.close();
  });

  await scenario('Sound settings persist per device and native media plays from gestures or recovers safely',async()=>{
    const context=await makeContext(),page=await openPage(context,{audio:true});let quizPosts=0;
    page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/quiz/')&&r.method()==='POST')quizPosts++;});
    for(const filename of ['correct.wav','wrong.wav']){const response=await context.request.get(targetBase+'/audio/'+filename);eq(response.status(),200);ok(/^audio\//i.test(response.headers()['content-type']||''),'The HTTP server declares generated cue audio');const bytes=await response.body();eq(bytes.subarray(0,4).toString(),'RIFF');eq(bytes.subarray(8,12).toString(),'WAVE');eq(bytes,await fs.readFile(path.join(root,'public/audio',filename)),'HTTP serves the exact generated cue bytes');}
    await page.locator('#settingsOpen').click();eq(await page.locator('#soundSetting').inputValue(),'on','Sound starts enabled without autoplay');eq(await page.evaluate(()=>window.__audioStarts.length),0);
    await page.locator('#soundSetting').selectOption('off');await page.locator('#settingsClose').click();await page.reload({waitUntil:'networkidle'});await page.locator('#settingsOpen').click();eq(await page.locator('#soundSetting').inputValue(),'off','The device sound preference survives a reload');eq(await page.evaluate(()=>window.__audioStarts.length),0,'A muted reload never starts playback');
    await page.locator('#soundSetting').selectOption('on');await page.waitForFunction(()=>window.__mediaEvents.some(e=>e.type==='ended'&&e.src.endsWith('/audio/correct.wav')),{},{timeout:4000});
    const preview=await page.evaluate(()=>({starts:window.__audioStarts.map(x=>({...x})),events:window.__mediaEvents}));eq(preview.starts.length,1,'Enabling sound plays one explicit preview');ok(preview.starts[0].src.endsWith('/audio/correct.wav'));ok(preview.starts[0].gesture,'Preview play is called synchronously in the setting gesture');ok(preview.starts[0].resolved&&!preview.starts[0].error,'The real media engine resolves the self-hosted cue');ok(preview.events.some(e=>e.type==='playing'&&e.src.endsWith('/audio/correct.wav')),'Native playback enters playing');ok(preview.events.some(e=>e.type==='ended'&&e.time>.3&&e.duration>.3&&e.duration<.9),'The decoded punchy correct clip advances and ends');
    await page.locator('#soundSetting').selectOption('off');await page.locator('#soundSetting').selectOption('on');await page.waitForFunction(()=>window.__audioStarts.length>=2);await page.locator('#soundSetting').selectOption('off');
    const quietCount=await page.evaluate(()=>window.__audioStarts.length),quietTimes=await page.evaluate(()=>window.__mediaNodes.map(n=>n.currentTime));await page.waitForTimeout(180);eq(await page.evaluate(()=>window.__audioStarts.length),quietCount,'Muting never schedules queued playback');ok(await page.evaluate(()=>window.__mediaNodes.every(n=>n.paused)),'Muting immediately pauses every active player');const afterQuiet=await page.evaluate(()=>window.__mediaNodes.map(n=>n.currentTime));ok(afterQuiet.every((time,i)=>Math.abs(time-quietTimes[i])<.02),'A muted clip cannot continue advancing');
    await page.locator('#settingsClose').click();await page.locator('#testOpen').click();await page.locator('#testStart').click();
    const answer=async wrong=>{const number=Number((await page.locator('#questionNumber').innerText()).match(/No\. (\d+)/)[1]),texts=await page.locator('#questionChoices .choice-text').allTextContents(),index=texts.indexOf(book('target1900')[number-1].english);ok(index>=0);await page.locator('#questionChoices button').nth(wrong?(index+1)%4:index).click();await waitForResult(page);};
    await answer(false);eq(await page.evaluate(()=>window.__audioStarts.length),quietCount,'A correct answer while muted makes no media play call');await advanceResult(page);await page.locator('#quizQuit').click();await page.locator('#quitConfirm').click();
    await page.locator('#settingsOpen').click();const completedPreviews=await page.evaluate(()=>window.__mediaEvents.filter(e=>e.type==='ended'&&e.src.endsWith('/audio/correct.wav')).length);await page.locator('#soundSetting').selectOption('on');await page.waitForFunction(n=>window.__mediaEvents.filter(e=>e.type==='ended'&&e.src.endsWith('/audio/correct.wav')).length>n,completedPreviews,{timeout:4000});await page.locator('#settingsClose').click();
    await page.evaluate(()=>{window.__audioStarts=[];window.__mediaEvents=[];});await page.locator('#testOpen').click();await page.locator('#testStart').click();
    await answer(false);await page.waitForFunction(()=>window.__mediaEvents.some(e=>e.type==='ended'&&e.src.endsWith('/audio/correct.wav')),{},{timeout:3000});
    const actualCorrect=await page.evaluate(()=>window.__audioStarts.map(x=>({...x})));eq(actualCorrect.length,1);ok(actualCorrect[0].gesture&&actualCorrect[0].trusted&&actualCorrect[0].stack.includes('selectChoice'),'Correct media.play is called synchronously within the trusted answer event');ok(actualCorrect[0].resolved,'The correct cue native playback resolved');ok(!actualCorrect[0].muted&&actualCorrect[0].volume>0,'The actual media element has audible settings');await advanceResult(page);
    await answer(true);await page.waitForFunction(()=>window.__mediaEvents.some(e=>e.type==='ended'&&e.src.endsWith('/audio/wrong.wav')),{},{timeout:3000});
    eq(await page.evaluate(()=>window.__audioStarts.length),2);ok((await page.evaluate(()=>window.__audioStarts[1].src)).endsWith('/audio/wrong.wav'));ok(await page.evaluate(()=>window.__mediaEvents.some(e=>e.type==='ended'&&e.src.endsWith('/audio/wrong.wav')&&e.time>.1&&e.duration>.1&&e.duration<.8)),'The separate failure clip is decoded and played to completion');await page.waitForTimeout(1100);eq(await page.evaluate(()=>window.__audioStarts.length),2,'Automatic progress plays no additional sound');
    await page.evaluate(()=>{window.__denyAudio=true;window.__blockedPlays=0;const observed=HTMLMediaElement.prototype.play;HTMLMediaElement.prototype.play=function(...args){if(window.__denyAudio){window.__blockedPlays++;return Promise.reject(new DOMException('Synthetic blocked playback','NotAllowedError'));}return observed.apply(this,args);};});
    const rejectedPosition=await page.locator('#questionPosition').innerText();await answer(false);ok(await page.evaluate(()=>window.__blockedPlays>0),'The separate failure fixture actually rejects playback');await page.waitForFunction(old=>document.getElementById('questionPosition').textContent!==old,rejectedPosition,{timeout:1800});
    await page.evaluate(()=>{window.__denyAudio=false;});await answer(true);await page.waitForFunction(()=>window.__audioStarts.length===3);ok(await page.evaluate(()=>window.__audioStarts[2].gesture),'A later gesture retries playback after rejection');await page.waitForFunction(()=>window.__audioStarts[2].resolved===true,{},{timeout:3000});
    await page.locator('#quizQuit').click();await page.locator('#quitConfirm').click();
    const classContext=await makeContext(),accountPin=pin();await register(classContext,9,'音確認H',accountPin);await target(context,'/api/login',{attendanceNumber:9,accountPin});await page.reload({waitUntil:'networkidle'});await page.locator('#settingsOpen').click();eq(await page.locator('#identityName').innerText(),'音確認H');ok(await page.locator('#soundSetting').isVisible(),'The same personal sound control is available to logged-in members');eq(await page.locator('#soundSetting').inputValue(),'on');await page.locator('#soundSetting').selectOption('off');eq(quizPosts,0,'Guest sound checks never submit shared scores');
    await page.close();await classContext.close();await context.close();
    const blockedStorage=await makeContext();await blockedStorage.addInitScript(()=>{Storage.prototype.getItem=function(){throw Error('Synthetic storage denial');};Storage.prototype.setItem=function(){throw Error('Synthetic storage denial');};});
    const storagePage=await openPage(blockedStorage,{audio:true});await storagePage.locator('#settingsOpen').click();await storagePage.locator('#soundSetting').selectOption('off');await storagePage.locator('#settingsClose').click();await storagePage.locator('#testOpen').click();await storagePage.locator('#testStart').click();await storagePage.locator('#questionChoices button').first().click();await waitForResult(storagePage);eq(await storagePage.evaluate(()=>window.__audioStarts.length),0,'Blocked persistence still permits in-memory mute and a completed answer');await storagePage.close();await blockedStorage.close();
  });

  await scenario('Acknowledged results stay one second then advance, with optional taps and safe timer isolation',async()=>{
    const context=await makeContext();await context.addInitScript(()=>{
      const original=crypto.getRandomValues.bind(crypto);window.__visualRewardRoll=null;
      crypto.getRandomValues=array=>{if(window.__visualRewardRoll!==null&&array instanceof Uint32Array&&array.length===1){array[0]=window.__visualRewardRoll;return array;}return original(array);};
    });
    const page=await openPage(context,{audio:true});let quizPosts=0;page.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/api/quiz/')&&request.method()==='POST')quizPosts++;});
    await page.locator('#testOpen').click();await page.locator('#questionCount').selectOption('50');await page.locator('#testStart').click();await page.locator('#questionChoices button').first().waitFor();
    await watchRewards(page);await watchResultProgress(page);eq(await page.locator('#quizNext').count(),0,'The visible Next button has been removed');
    let earned=0;const timings=[],tiers=[[17,100,'standard',6],[16,1000,'bonus',12],[1,10000,'jackpot',24]],sizes=[[320,568],[375,667],[390,844],[430,932],[1280,900]];
    const position=()=>page.locator('#questionPosition').innerText();
    async function choose(roll,{wrong=false}={}){
      await page.evaluate(value=>{window.__visualRewardRoll=value;},roll);
      const number=Number((await page.locator('#questionNumber').innerText()).match(/No\. (\d+)/)[1]),texts=await page.locator('#questionChoices .choice-text').allTextContents(),correct=texts.indexOf(book('target1900')[number-1].english);ok(correct>=0);
      const before=await page.evaluate(()=>({reward:window.__rewardObservations.length,result:window.__resultPlaybacks.length})),oldPosition=await position();
      await page.locator('#questionChoices button').nth(wrong?(correct+1)%4:correct).click();await waitForResult(page);
      await page.waitForFunction(n=>window.__resultPlaybacks.length===n+1,before.result);
      eq(await position(),oldPosition,'The answer gesture itself cannot advance the newly shown result');
      return{...before,position:oldPosition,choiceIndex:wrong?(correct+1)%4:correct};
    }
    async function autoProgress(before){
      await page.waitForFunction(index=>window.__resultPlaybacks[index]?.progressedAt!==undefined,before.result,{timeout:1800});
      const event=await page.evaluate(index=>window.__resultPlaybacks[index],before.result);ok(event.elapsed>=900&&event.elapsed<=1400,'A confirmed result remains for approximately one second');
      eq(await page.locator('#quizAdvanceSurface').evaluate(node=>node.hidden),true,'Automatic progress removes its tap surface');
      eq(await page.locator('#questionChoices button[aria-pressed="true"]').count(),0,'Auto progress never answers the next question');
      ok(!await page.locator('#answerFeedback').isVisible(),'The next question has no inherited verdict');ok(await page.evaluate(()=>{const rain=document.getElementById('jackpotBillRain');return !rain||(rain.hidden&&rain.children.length===0);}), 'Auto progress removes the jackpot bundles and their animations');return event;
    }
    for(const [roll,amount,tier,particles] of tiers){
      for(const [width,height] of sizes){
        await page.setViewportSize({width,height});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        const before=await choose(roll);earned+=amount;const visual=await page.evaluate(index=>window.__rewardObservations[index],before.reward);
        eq(visual.tier,tier);eq(visual.amount,amount);eq(visual.particles,particles);eq(visual.rays,tier==='jackpot');eq(visual.rings,tier==='jackpot'?2:0);eq(visual.rain.shown,tier==='jackpot','Only the jackpot shows falling banknote bundles');eq(visual.rain.count,tier==='jackpot'?20:0);if(tier==='jackpot'){eq(visual.rain.pointer,'none');eq(visual.rain.aria,'true');eq(visual.rain.position,'fixed');ok(visual.rain.width>=width-1&&visual.rain.height>=height-1,'Jackpot rain spans the visible screen');ok(visual.rain.frames.every(note=>note.duration>0&&note.duration<=1000&&note.frames.some(frame=>frame.includes('-110px'))),'Every bundle starts above the screen and uses a finite short fall');}
        ok(visual.font>=50&&visual.amountFits&&!visual.overflow,'Every tier fits at '+width);ok(visual.overlap&&visual.overlayOverlap);eq(visual.pointerEvents,'none');eq(visual.aria,'true');ok(visual.advanceReady,'The result supports an immediate optional tap');ok(visual.opacity>=.9);ok(visual.cardDuration.some(duration=>duration>0&&duration<=100));
        if(width===320||width===390){await page.waitForTimeout(100);await page.screenshot({path:path.join(reportDir,'reward-auto-'+tier+'-'+width+'.png'),fullPage:true});}
        eq(displayedPoints(await page.locator('#quizPoints').innerText()),earned);eq(await page.locator('#rewardAnnouncement').textContent(),'+'+amount.toLocaleString('ja-JP')+'円');
        const event=await autoProgress(before);timings.push({tier,width,elapsed:event.elapsed});eq(displayedPoints(await page.locator('#quizPoints').innerText()),earned,'Auto progress preserves confirmed points');
      }
    }
    await page.emulateMedia({reducedMotion:'reduce'});await page.setViewportSize({width:390,height:844});
    for(const [roll,amount] of tiers){const before=await choose(roll);earned+=amount;const visual=await page.evaluate(index=>window.__rewardObservations[index],before.reward);eq(visual.animations,0,'Reduced-motion results are static');ok(!visual.rain.shown&&visual.rain.count===0,'Reduced motion never rains banknotes');await autoProgress(before);}
    await page.emulateMedia({reducedMotion:'no-preference'});

    const first=await choose(0);earned+=10000;await page.waitForTimeout(140);const began=Date.now();await advanceResult(page);ok(Date.now()-began<300,'A result tap advances before the one-second deadline');ok(await page.evaluate(()=>{const layer=document.getElementById('jackpotBillRain');return !layer||(layer.hidden&&layer.children.length===0);}), 'An early result tap clears every falling note');
    await page.waitForTimeout(350);const second=await choose(17);earned+=100;await page.waitForTimeout(570);
    eq(await position(),second.position,'The first result timer cannot advance a newer result');ok(await page.locator('#rewardCelebration').isVisible(),'The newer reward keeps its own full display period');
    await autoProgress(second);eq(displayedPoints(await page.locator('#quizPoints').innerText()),earned);

    const detailed=await choose(17);earned+=100;const detailBox=await page.locator('#questionChoices button').nth(detailed.choiceIndex).boundingBox();await page.mouse.click(detailBox.x+detailBox.width/2,detailBox.y+detailBox.height/2,{clickCount:2});await page.waitForFunction(old=>document.getElementById('questionPosition').textContent!==old,detailed.position,{timeout:500});ok(!await page.locator('#answerFeedback').isVisible(),'A quick same-position second tap advances the result once');await page.waitForTimeout(350);

    const disabledTap=await choose(17);earned+=100;const disabled=await page.locator('#questionChoices button').first().boundingBox();ok(disabled);
    await page.mouse.click(disabled.x+disabled.width/2,disabled.y+disabled.height/2);await page.waitForFunction(old=>document.getElementById('questionPosition').textContent!==old,disabledTap.position);
    const newPosition=await position();await page.mouse.click(disabled.x+disabled.width/2,disabled.y+disabled.height/2);await page.mouse.click(disabled.x+disabled.width/2,disabled.y+disabled.height/2);
    eq(await position(),newPosition,'Rapid repeated result taps do not skip or answer the next question');ok(!await page.locator('#answerFeedback').isVisible());eq(await page.locator('#questionChoices button[aria-pressed="true"]').count(),0);await page.waitForTimeout(350);

    const held=await choose(17);earned+=100;const heldBox=await page.locator('#questionChoices button').first().boundingBox();await page.mouse.move(heldBox.x+heldBox.width/2,heldBox.y+heldBox.height/2);await page.waitForTimeout(450);await page.mouse.down();await page.waitForTimeout(700);
    eq(await position(),held.position,'Holding a result gesture across the deadline cannot expose a new answer target');await page.mouse.up();await page.waitForFunction(old=>document.getElementById('questionPosition').textContent!==old,held.position);
    const afterHeld=await position();await page.waitForTimeout(1100);eq(await position(),afterHeld,'Releasing the held gesture progresses exactly once');ok(!await page.locator('#answerFeedback').isVisible());eq(await page.locator('#questionChoices button[aria-pressed="true"]').count(),0);

    for(const key of ['Enter','Space']){const before=await choose(17);earned+=100;await page.locator('#quizAdvanceSurface').focus();await page.keyboard.press(key);await page.waitForFunction(old=>document.getElementById('questionPosition').textContent!==old,before.position);ok(!await page.locator('#answerFeedback').isVisible(),'Keyboard progress does not select an answer');}
    const wrong=await choose(17,{wrong:true});eq(await page.locator('#feedbackTitle').innerText(),'不正解');ok((await page.locator('#feedbackAnswer').innerText()).startsWith('正解：'));ok(!await page.locator('#rewardCelebration').isVisible());await autoProgress(wrong);eq(displayedPoints(await page.locator('#quizPoints').innerText()),earned,'Wrong auto progress awards nothing');

    const paused=await choose(0);earned+=10000;const sounds=await page.evaluate(()=>window.__audioStarts.length);await page.locator('#quizQuit').click();await page.waitForTimeout(1150);eq(await position(),paused.position,'An open quit dialog pauses automatic progress');ok(!await page.locator('#quizAdvanceSurface').isVisible());ok(await page.evaluate(()=>{const layer=document.getElementById('jackpotBillRain');return !layer||(layer.hidden&&layer.children.length===0);}), 'Quit immediately removes every jackpot banknote');
    await page.locator('#quitCancel').click();await waitForResult(page);const resumed=await page.evaluate(()=>window.__resultPlaybacks.length-1);eq(await page.evaluate(()=>window.__audioStarts.length),sounds,'Resuming a result does not replay its cue');ok(await page.evaluate(()=>{const layer=document.getElementById('jackpotBillRain');return !layer||layer.hidden;}),'Resuming a confirmed jackpot does not rain the same reward again');await page.waitForTimeout(350);eq(await position(),paused.position,'A cancelled quit gives the result a fresh readable interval');await autoProgress({result:resumed});

    const background=await choose(0);earned+=10000;await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});ok(await page.evaluate(()=>window.__mediaNodes.every(node=>node.paused)), 'The background signal pauses native audio immediately');await page.waitForTimeout(1100);eq(await position(),background.position,'A background visibility signal pauses auto progress');ok(!await page.locator('#quizAdvanceSurface').isVisible());ok(await page.evaluate(()=>{const layer=document.getElementById('jackpotBillRain');return !layer||(layer.hidden&&layer.children.length===0);}), 'Backgrounding cancels jackpot note animations');ok(await page.evaluate(()=>window.__mediaNodes.every(node=>node.paused)), 'Backgrounding pauses native audio');
    await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});await waitForResult(page);const restored=await page.evaluate(()=>window.__resultPlaybacks.length-1);await autoProgress({result:restored});eq(displayedPoints(await page.locator('#quizPoints').innerText()),earned,'Background restoration keeps the same earned points');

    await choose(0);earned+=10000;await page.locator('#quizQuit').click();await page.locator('#quitConfirm').click();await page.waitForTimeout(1150);ok(await page.locator('#homeView').isVisible());ok(!await page.locator('#rewardCelebration').isVisible());ok(!await page.locator('#quizAdvanceSurface').isVisible());eq(await page.locator('#rewardAnnouncement').textContent(),'');eq(quizPosts,0,'Guest result tests never submit shared scores');
    await fs.writeFile(path.join(reportDir,'reward-auto-timings.json'),JSON.stringify({timings,visibilitySignalSimulated:true,physicalSafariVerified:false},null,2)+'\n');await page.close();await context.close();
  });

  await scenario('The last result opens the final score once through automatic progress or repeated taps',async()=>{
    const context=await makeContext(),page=await openPage(context);let quizPosts=0;page.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/api/quiz/')&&request.method()==='POST')quizPosts++;});
    let finalBoxes;for(const [mode,lastCorrect] of [['auto',true],['auto',false],['tap-again',true],['tap-ranking',false]]){
      await page.locator('#testOpen').click();await page.locator('#questionCount').selectOption('10');await page.locator('#testStart').click();let count=0,points=0;
      for(let index=0;index<10;index++){
        const number=Number((await page.locator('#questionNumber').innerText()).match(/No\. (\d+)/)[1]),texts=await page.locator('#questionChoices .choice-text').allTextContents(),correct=texts.indexOf(book('target1900')[number-1].english),right=index<9||lastCorrect;ok(correct>=0);
        await page.locator('#questionChoices button').nth(right?correct:(correct+1)%4).click();await waitForResult(page);if(right){count++;points+=displayedPoints(await page.locator('#feedbackReward').textContent());}
        eq(await page.locator('#questionPosition').innerText(),(index+1)+' / 10問','The final answer gesture does not immediately skip the result');
        if(index<9)await advanceResult(page);else if(mode==='auto'){const then=Date.now();await page.locator('#resultView').waitFor({state:'visible',timeout:1800});ok(Date.now()-then>=850,'The final result remains visible for its one-second interval');}else{const box=finalBoxes[mode==='tap-again'?'again':'ranking'],x=box.x+box.width/2,y=box.y+box.height/2;await page.mouse.click(x,y,{clickCount:1});await page.locator('#resultView').waitFor({state:'visible',timeout:500});await page.mouse.click(x,y,{clickCount:2});await page.waitForTimeout(60);ok(await page.locator('#resultView').isVisible(),'A repeated final tap cannot activate a newly exposed result-page button');}
      }
      eq(Number(await page.locator('#resultCorrect').innerText()),count);eq(displayedPoints(await page.locator('#resultPoints').innerText()),points);finalBoxes={again:await page.locator('#testAgain').boundingBox(),ranking:await page.locator('#resultRanking').boundingBox()};await page.waitForTimeout(1100);ok(await page.locator('#resultView').isVisible(),'A finished quiz cannot auto-advance twice');await page.locator('#resultView [data-home]').click();
    }
    eq(quizPosts,0);await page.close();await context.close();
  });

  await scenario('KGS attendance and PIN login creates only a private Target cookie',async()=>{
    const page=await openPage(A);await page.locator('#settingsOpen').click();await page.locator('#attendanceNumber').fill('1');await page.locator('#accountPin').fill(pinA);
    await page.locator('#pinVisibility').click();eq(await page.locator('#accountPin').getAttribute('type'),'text');await page.locator('#pinVisibility').click();eq(await page.locator('#accountPin').getAttribute('type'),'password');
    const signed=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/login');await page.locator('#loginButton').click();eq((await signed).status(),200);await page.locator('#identityName').waitFor({state:'visible'});
    eq(await page.locator('#accountPin').inputValue(),'');const session=await target(A,'/api/session');eq(session.member,{name:'練習する人A'});eq(session.correctCount,0);eq(session.totalPoints,0);
    const cookies=await A.cookies(targetBase);ok(cookies.some(c=>c.httpOnly&&c.sameSite==='Strict'),'Target session is HttpOnly and SameSite Strict');
    const storage=await page.evaluate(()=>JSON.stringify({local:Object.fromEntries(Object.entries(localStorage)),session:Object.fromEntries(Object.entries(sessionStorage)),cookies:document.cookie}));for(const value of [pinA,integrationSecret,rpcSecret,cookieSecret])ok(!storage.includes(value),'No login credential lives in browser-readable storage');
    await page.close();await target(B,'/api/login',{attendanceNumber:2,accountPin:pinB});
  });

  await scenario('Authoritative grading and concurrent answer retries award one score only',async()=>{
    const quiz=await begin(A,'target1900','english',1,10),question=quiz.question,choice=correctChoice(question,'target1900','english'),requestId=uuid();
    const [first,second]=await Promise.all([submit(A,quiz,question,choice,requestId),submit(A,quiz,question,choice,requestId)]);eq(first,second,'Retry returns the same accepted outcome');eq(first.correct,true);eq(first.correctCount,1);eq(first.answeredCount,1);pointsA+=reward(first,0,pointsA,true);eq((await target(A,'/api/session')).correctCount,1);eq((await target(A,'/api/session')).totalPoints,pointsA);const accepted=(await targetDb.query('SELECT award_points,response FROM target_private.answers WHERE quiz_id=$1 AND question_id=$2',[quiz.quizId,question.id])).rows;eq(accepted.length,1);eq(Number(accepted[0].award_points),first.awardPoints);eq(accepted[0].response,first);
    await target(A,'/api/quiz/answer',{quizId:quiz.quizId,questionId:question.id,choiceId:question.choices.find(c=>c.id!==choice.id).id,requestId:uuid()},409);
    let result=first;for(let n=1;n<10;n++){const next=result.nextQuestion;ok(next,'Next question is issued after the accepted answer');const option=correctChoice(next,'target1900','english'),before=result.quizPoints;result=await submit(A,quiz,next,option);pointsA+=reward(result,before,pointsA,true);}
    eq(result.finished,true);eq(result.nextQuestion,null);eq(result.correctCount,10);eq(result.quizPoints,pointsA);eq((await target(A,'/api/session')).correctCount,10);eq((await target(A,'/api/session')).totalPoints,pointsA);
  });

  await scenario('Reverse-direction idioms grade a wrong answer without increasing the total',async()=>{
    const quiz=await begin(A,'target1000','japanese',1,10),correct=correctChoice(quiz.question,'target1000','japanese');const wrong=quiz.question.choices.find(c=>c.id!==correct.id);const result=await submit(A,quiz,quiz.question,wrong);eq(result.correct,false);eq(result.correctChoiceId,correct.id);eq(result.correctText,correct.text);eq(result.correctCount,0);reward(result,0,pointsA,false);eq((await target(A,'/api/session')).correctCount,10);eq((await target(A,'/api/session')).totalPoints,pointsA);
    await target(B,'/api/quiz/answer',{quizId:quiz.quizId,questionId:result.nextQuestion.id,choiceId:result.nextQuestion.choices[0].id,requestId:uuid()},404);
    await target(A,'/api/quiz/start',{book:'target1000',direction:'japanese',count:10,from:1,to:10,requestId:uuid(),correctCount:1000},400);await target(A,'/api/quiz/answer',{quizId:quiz.quizId,questionId:result.nextQuestion.id,choiceId:result.nextQuestion.choices[0].id,requestId:uuid(),awardPoints:10000},400);await target(A,'/api/quiz/answer',{quizId:quiz.quizId,questionId:result.nextQuestion.id,choiceId:result.nextQuestion.choices[0].id,requestId:uuid(),rewardRoll:0},400);
  });

  await scenario('Independent clients share a names-only ranking with stable account ownership',async()=>{
    const quiz=await begin(B,'target1000','english',21,30),answer=correctChoice(quiz.question,'target1000','english'),result=await submit(B,quiz,quiz.question,answer);pointsB+=reward(result,0,pointsB,true);
    const ranking=(await target(Guest,'/api/ranking')).ranking;eq(ranking.length,2);eq([...ranking.map(r=>r.correctCount)].sort((a,b)=>b-a),[10,1]);eq(new Set(ranking.map(r=>r.name)),new Set(['練習する人A','練習する人B']));eq(ranking.map(r=>r.totalPoints),[pointsA,pointsB].sort((a,b)=>b-a),'Ranking orders by cumulative points rather than correct answers');for(const row of ranking)eq(Object.keys(row).sort(),['rank','name','correctCount','totalPoints'].sort());ok(!JSON.stringify(ranking).includes(memberA.id)&&!JSON.stringify(ranking).includes(memberB.id),'Stable member IDs never appear in the public ranking');
    const another=await makeContext();await target(another,'/api/login',{attendanceNumber:1,accountPin:pinA});eq((await target(another,'/api/session')).correctCount,10,'The same account retains its correct count on another device');eq((await target(another,'/api/session')).totalPoints,pointsA,'The same account retains cumulative points on another device');
    await kgs(KgsA,'/api/profile',{name:'名前を変えた人A'});eq((await target(A,'/api/session')).member,{name:'名前を変えた人A'});eq(new Set((await target(Guest,'/api/ranking')).ranking.map(r=>r.name)),new Set(['名前を変えた人A','練習する人B']));eq((await target(A,'/api/session')).totalPoints,pointsA);await another.close();
  });

  await scenario('Scores and sessions survive a Target HTTP server restart',async()=>{
    await stop('target');await start('target');eq((await target(A,'/api/session')).correctCount,10);eq((await target(B,'/api/session')).correctCount,1);eq((await target(Guest,'/api/ranking')).ranking.map(r=>r.totalPoints),[pointsA,pointsB].sort((a,b)=>b-a));eq((await target(A,'/api/session')).totalPoints,pointsA);eq((await target(B,'/api/session')).totalPoints,pointsB);
  });

  await scenario('A dropped answer request keeps the selected answer for one real retry',async()=>{
    const page=await openPage(A,{audio:true});await page.locator('#testOpen').click();await page.locator('#testStart').click();await page.locator('#questionChoices button').first().waitFor();
    const number=Number((await page.locator('#questionNumber').innerText()).match(/No\. (\d+)/)[1]);
    const correct=book('target1900')[number-1].english,choices=await page.locator('#questionChoices .choice-text').allTextContents(),wrong=choices.findIndex(text=>text!==correct);
    const before=Number((await targetDb.query('SELECT count(*)::int AS n FROM target_private.answers')).rows[0].n),requests=[];
    let failNext=true;await page.route('**/api/quiz/answer',async route=>{requests.push(JSON.parse(route.request().postData()));if(failNext){failNext=false;await route.abort('failed');}else await route.continue();});
    const prompt=await page.locator('#questionPrompt').innerText();await page.locator('#questionChoices button').nth(wrong).click();await page.locator('#answerRetry').waitFor({state:'visible'});eq(requests.length,1,'One choice tap sends exactly one answer');await page.waitForFunction(()=>window.__audioStarts.length>0);const soundStarts=await page.evaluate(()=>window.__audioStarts.length);ok(soundStarts>0,'Wrong-answer feedback schedules a short cue from its tap');
    eq(await page.locator('#questionPrompt').innerText(),prompt,'A failed transmission cannot advance the question');
    eq(Number((await targetDb.query('SELECT count(*)::int AS n FROM target_private.answers')).rows[0].n),before,'The aborted request has not awarded a score');
    await page.locator('#answerRetry').click();await waitForResult(page);eq(await page.locator('#feedbackTitle').innerText(),'不正解');eq(requests.length,2);eq(requests[0],requests[1],'Retry reuses the exact answer and request ID');eq(await page.evaluate(()=>window.__audioStarts.length),soundStarts,'Retry never schedules the feedback cue again');eq((await target(A,'/api/session')).totalPoints,pointsA);ok(!await page.locator('#feedbackReward').isVisible(),'Wrong answers cannot show a reward after retry');
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

  await scenario('One hundred server-graded questions stay unique and inside the chosen sections',async()=>{
    for(const [number,name,bookName,direction,from,to] of [[3,'百問確認C','target1900','english',1,100],[5,'百問確認D','target1000','japanese',901,1000]]){
      const classContext=await makeContext(),context=await makeContext(),accountPin=pin();
      await register(classContext,number,name,accountPin,codeChanged);await target(context,'/api/login',{attendanceNumber:number,accountPin});
      for(const cookie of await context.cookies(targetBase))remember(cookie.value);
      const quiz=await begin(context,bookName,direction,from,to,100);eq(quiz.total,100);eq(quiz.correctCount,0);
      const seen=new Set();let result={nextQuestion:quiz.question},quizPoints=0;
      for(let index=0;index<100;index++){
        const question=result.nextQuestion;ok(question.number>=from&&question.number<=to,'Every question stays within selected sections');ok(!seen.has(question.number),'Question numbers never repeat');seen.add(question.number);
        result=await submit(context,quiz,question,correctChoice(question,bookName,direction));quizPoints+=reward(result,quizPoints,quizPoints,true);eq(result.answeredCount,index+1);eq(result.correctCount,index+1);
      }
      eq(seen.size,100);eq(result.finished,true);eq(result.nextQuestion,null);eq((await target(context,'/api/session')).correctCount,100);eq((await target(context,'/api/session')).totalPoints,quizPoints);const ledger=(await targetDb.query('SELECT sum(award_points)::text AS points FROM target_private.answers WHERE quiz_id=$1',[quiz.quizId])).rows[0];eq(Number(ledger.points),quizPoints,'One hundred persisted awards equal the confirmed quiz and lifetime totals');
      const fifty=await begin(context,bookName,direction,1,500,50);eq(fifty.total,50);
      const stored=(await targetDb.query('SELECT questions FROM target_private.quizzes WHERE id=$1',[fifty.quizId])).rows[0].questions;
      eq(stored.length,50);eq(new Set(stored.map(question=>question.number)).size,50);ok(stored.every(question=>question.number>=1&&question.number<=500),'A multi-section range is retained on the server');
      eq((await begin(context,bookName,direction,1,100,20)).total,20,'An old client can continue starting its supported legacy20 test');
      await target(context,'/api/quiz/start',{book:bookName,direction,count:101,from:1,to:500,requestId:uuid()},400);
      await classContext.close();await context.close();
    }
  });

  await scenario('An old zero-point answer replays safely and only new correct answers earn rewards',async()=>{
    const classContext=await makeContext(),context=await makeContext(),accountPin=pin(),legacyMember=await register(classContext,7,'旧記録確認F',accountPin,codeChanged);await target(context,'/api/login',{attendanceNumber:7,accountPin});
    const quiz=await begin(context,'target1900','english',1,100,10),question=quiz.question,choice=correctChoice(question,'target1900','english'),requestId=uuid();
    const next=(await targetDb.query('SELECT target_private.public_question(questions->1) AS next FROM target_private.quizzes WHERE id=$1',[quiz.quizId])).rows[0].next;
    const oldResponse={correct:true,correctChoiceId:choice.id,correctText:choice.text,answeredCount:1,correctCount:1,total:10,finished:false,nextQuestion:next},bytes=Buffer.byteLength(JSON.stringify(oldResponse))+256;
    const client=await targetDb.connect();try{await client.query('BEGIN');await client.query('INSERT INTO target_private.answers(quiz_id,member_id,question_id,choice_id,request_id,request_ids,response,charged_bytes) VALUES($1,$2,$3,$4,$5,ARRAY[$5::uuid],$6::jsonb,$7)',[quiz.quizId,legacyMember.id,question.id,choice.id,requestId,JSON.stringify(oldResponse),bytes]);await client.query('UPDATE target_private.quizzes SET answered_count=1,correct_count=1 WHERE id=$1',[quiz.quizId]);await client.query('UPDATE target_private.profiles SET answered_count=1,correct_count=1 WHERE member_id=$1',[legacyMember.id]);await client.query('UPDATE target_private.system_state SET answer_count=answer_count+1,logical_bytes=logical_bytes+$1 WHERE singleton',[bytes]);await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    const replay=await submit(context,quiz,question,choice,requestId);eq(replay,{...oldResponse,awardPoints:0,quizPoints:0,totalPoints:0},'Historical responses gain zero-valued fields without inventing rewards');eq((await target(context,'/api/session')).correctCount,1);eq((await target(context,'/api/session')).totalPoints,0);
    const earned=await submit(context,quiz,next,correctChoice(next,'target1900','english'));reward(earned,0,0,true);eq(earned.correctCount,2);eq((await target(context,'/api/session')).totalPoints,earned.awardPoints);
    eq(await submit(context,quiz,question,choice,requestId),replay,'Historical replay remains its accepted snapshot');eq((await target(context,'/api/session')).totalPoints,earned.awardPoints,'Historical retries never reset new earned points');eq((await targetDb.query('SELECT award_points FROM target_private.answers WHERE quiz_id=$1 AND question_id=$2',[quiz.quizId,question.id])).rows[0].award_points,0);
    await classContext.close();await context.close();
  });

  await scenario('A finished recorded test shows its correct count and earned points even without available audio',async()=>{
    const classContext=await makeContext(),context=await makeContext(),accountPin=pin();await register(classContext,8,'結果確認G',accountPin,codeChanged);await target(context,'/api/login',{attendanceNumber:8,accountPin});
    const page=await context.newPage();await page.addInitScript(()=>{class UnavailableAudio{constructor(){throw Error('Audio unavailable in this browser');}}window.Audio=UnavailableAudio;window.AudioContext=UnavailableAudio;window.webkitAudioContext=UnavailableAudio;HTMLMediaElement.prototype.play=function(){return Promise.reject(new DOMException('Test audio unavailable','NotAllowedError'));};});page.on('pageerror',error=>runtimeErrors.push(error.message));await page.goto(targetBase,{waitUntil:'networkidle'});await page.locator('#testOpen').click();await page.locator('#questionCount').selectOption('10');await page.locator('#testStart').click();let earned=0,correctCount=0;
    for(let index=0;index<10;index++){
      await page.locator('#questionChoices button').first().waitFor();const number=Number((await page.locator('#questionNumber').innerText()).match(/No\. (\d+)/)[1]),texts=await page.locator('#questionChoices .choice-text').allTextContents(),correct=texts.indexOf(book('target1900')[number-1].english);ok(correct>=0);const selected=index<8?correct:(correct+1)%4;
      await page.locator('#questionChoices button').nth(selected).click();await waitForResult(page);if(index<8){correctCount++;const amount=displayedPoints(await page.locator('#feedbackReward').innerText());ok([100,1000,10000].includes(amount));earned+=amount;}else ok(!await page.locator('#feedbackReward').isVisible());eq(displayedPoints(await page.locator('#quizPoints').innerText()),earned);await advanceResult(page);
    }
    await page.locator('#resultView').waitFor({state:'visible'});eq(Number(await page.locator('#resultCorrect').innerText()),correctCount);eq(correctCount,8);eq(await page.locator('#resultTotal').innerText(),'/ 10問');eq(displayedPoints(await page.locator('#resultPoints').innerText()),earned);ok((await page.locator('#resultPoints').innerText()).includes('円'));const session=await target(context,'/api/session');eq(session.correctCount,8);eq(session.totalPoints,earned);for(const width of [320,375,390,430,1280])await layout(page,width,'reward-result');await page.close();await classContext.close();await context.close();
  });

  await scenario('One choice tap gives immediate material feedback while the server confirms the score',async()=>{
    const classContext=await makeContext(),context=await makeContext(),accountPin=pin();
    await register(classContext,6,'回答操作確認E',accountPin,codeChanged);await target(context,'/api/login',{attendanceNumber:6,accountPin});
    for(const cookie of await context.cookies(targetBase))remember(cookie.value);
    const page=await openPage(context,{audio:true}),starts=[],answers=[];
    page.on('request',request=>{const route=new URL(request.url()).pathname;if(route==='/api/quiz/start')starts.push(JSON.parse(request.postData()));if(route==='/api/quiz/answer')answers.push(JSON.parse(request.postData()));});
    await page.locator('#homeSectionFrom').selectOption('1');await page.locator('#homeSectionTo').selectOption('5');await page.locator('#testOpen').click();
    eq(await page.locator('#rangeFrom').inputValue(),'1');eq(await page.locator('#rangeTo').inputValue(),'5');await page.locator('#questionCount').selectOption('100');await page.locator('#testStart').click();await page.locator('#questionChoices button').first().waitFor();
    eq(starts.length,1);eq({book:starts[0].book,count:starts[0].count,from:starts[0].from,to:starts[0].to},{book:'target1900',count:100,from:1,to:500});
    eq(await page.locator('#quizSubmit').count(),0,'A choice tap is the only answer submission control');eq(answers.length,0,'An unanswered question has sent no answer');
    const questionNumber=Number((await page.locator('#questionNumber').innerText()).match(/No\. (\d+)/)[1]),correctText=book('target1900')[questionNumber-1].english;
    const texts=await page.locator('#questionChoices .choice-text').allTextContents(),correct=texts.indexOf(correctText),wrong=texts.findIndex(text=>text!==correctText);ok(correct>=0&&wrong>=0);
    for(const [width,height] of [[320,568],[375,667],[390,844],[430,932],[1280,900]]){
      await page.setViewportSize({width,height});ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      const fonts=await page.locator('#questionChoices .choice-text').evaluateAll(nodes=>nodes.map(node=>({size:parseFloat(getComputedStyle(node).fontSize),weight:parseInt(getComputedStyle(node).fontWeight,10)})));ok(fonts.every(font=>font.size>=20&&font.weight>=650),'All answer text is large and bold');
      await page.locator('#questionChoices button').last().scrollIntoViewIfNeeded();ok(await page.locator('#questionChoices button').last().isVisible(),'Every choice remains reachable on phones');
    }
    await page.setViewportSize({width:390,height:844});
    let release,serverAccepted;const gate=new Promise(resolve=>{release=resolve;}),accepted=new Promise(resolve=>{serverAccepted=resolve;});
    await page.route('**/api/quiz/answer',async route=>{const response=await route.fetch();serverAccepted();await gate;await route.fulfill({response});});
    await page.evaluate(()=>{window.__confirmedCelebrations=0;const celebration=document.getElementById('rewardCelebration');let wasShown=!celebration.hidden;new MutationObserver(()=>{const shown=!celebration.hidden;if(shown&&!wasShown)window.__confirmedCelebrations++;wasShown=shown;}).observe(celebration,{attributes:true,attributeFilter:['hidden']});window.__hintMs=null;const start=()=>{const began=performance.now(),observer=new MutationObserver(()=>{if(!document.getElementById('answerFeedback').hidden){window.__hintMs=performance.now()-began;observer.disconnect();}});observer.observe(document.getElementById('answerFeedback'),{attributes:true,attributeFilter:['hidden']});};document.getElementById('questionChoices').addEventListener('click',start,{capture:true,once:true});});
    try{
      await page.locator('#questionChoices button').nth(correct).click();await page.locator('#answerFeedback').waitFor({state:'visible',timeout:1500});
      eq(await page.locator('#feedbackTitle').innerText(),'正解');eq(await page.locator('#questionChoices button').nth(correct).getAttribute('aria-pressed'),'true');eq(await page.locator('#questionChoices button').nth(wrong).getAttribute('aria-pressed'),'false');
      const hint=await page.evaluate(()=>window.__hintMs);materialFeedbackMs=hint;ok(Number.isFinite(hint)&&hint<200,'One choice tap shows material-backed feedback before the held HTTP response');
      await accepted;eq(displayedPoints(await page.locator('#quizPoints').innerText()),0,'Unconfirmed rewards cannot affect the displayed quiz total');ok(!await page.locator('#feedbackReward').isVisible(),'The random reward stays hidden until acknowledged');ok(!await page.locator('#rewardCelebration').isVisible(),'The decorative layer also waits for the real acknowledgement');ok(await page.evaluate(()=>{const layer=document.getElementById('jackpotBillRain');return !layer||layer.hidden;}),'Banknote rain also waits for the real acknowledgement');eq(await page.evaluate(()=>window.__confirmedCelebrations),0);await page.waitForFunction(()=>window.__audioStarts.length>0);const cueCount=await page.evaluate(()=>window.__audioStarts.length);eq(cueCount,1,'The correct cue plays one generated audio file');ok((await page.evaluate(()=>window.__audioStarts[0].src)).endsWith('/audio/correct.wav'));ok(await page.evaluate(()=>window.__audioStarts[0].gesture&&window.__audioStarts[0].trusted&&window.__audioStarts[0].stack.includes('selectChoice')),'Correct playback begins directly in the trusted answer event');eq(await page.locator('#quizCorrect').innerText(),'0問 正解','The confirmed score does not change before server acknowledgement');ok(!await page.locator('#quizAdvanceSurface').isVisible(),'Progress waits for an accepted authoritative result');await page.waitForTimeout(1100);eq(await page.locator('#questionPosition').innerText(),'1 / 100問','A pending material hint never starts automatic progress');ok((await page.locator('#quizMode').innerText()).includes('記録中'));
      await page.locator('#questionChoices button').evaluateAll(buttons=>{for(const button of buttons)button.dispatchEvent(new MouseEvent('click',{bubbles:true}));buttons[0].dispatchEvent(new MouseEvent('click',{bubbles:true}));});eq(answers.length,1,'Repeated or other choice taps cannot send another answer while confirmation is pending');eq(await page.evaluate(()=>window.__audioStarts.length),cueCount,'Repeated choices cannot repeat the feedback sound');
      eq(await page.locator('#questionChoices button').nth(correct).getAttribute('aria-pressed'),'true','Repeated taps cannot replace the submitted selection');
    }finally{release();}
    await waitForResult(page);eq(await page.locator('#quizCorrect').innerText(),'1問 正解');eq((await target(context,'/api/session')).correctCount,1);const confirmedPoints=(await target(context,'/api/session')).totalPoints;ok([100,1000,10000].includes(confirmedPoints));eq(displayedPoints(await page.locator('#quizPoints').innerText()),confirmedPoints);eq(displayedPoints(await page.locator('#feedbackReward').innerText()),confirmedPoints);eq(await page.evaluate(()=>window.__audioStarts.length),1,'The confirmed reply does not repeat the material-feedback sound');eq(await page.evaluate(()=>window.__confirmedCelebrations),1,'The confirmed real reply animates its award exactly once');
    await page.unroute('**/api/quiz/answer');await advanceResult(page);ok(!await page.locator('#rewardCelebration').isVisible(),'The recorded next question clears its award layer');ok(!await page.locator('#answerFeedback').isVisible());eq(await page.locator('#questionChoices button[aria-pressed="true"]').count(),0,'The next question clears the old selection');eq(await page.locator('#questionChoices button:enabled').count(),4,'The next question is immediately ready for one tap');
    const nextNumber=Number((await page.locator('#questionNumber').innerText()).match(/No\. (\d+)/)[1]),nextTexts=await page.locator('#questionChoices .choice-text').allTextContents(),nextWrong=nextTexts.findIndex(text=>text!==book('target1900')[nextNumber-1].english);await page.locator('#questionChoices button').nth(nextWrong).click();await waitForResult(page);eq(await page.locator('#feedbackTitle').innerText(),'不正解');await page.waitForFunction(()=>window.__audioStarts.length===2);ok((await page.evaluate(()=>window.__audioStarts[1].src)).endsWith('/audio/wrong.wav'),'Wrong answers play their separate generated failure cue');eq((await target(context,'/api/session')).totalPoints,confirmedPoints,'A wrong second question does not increase the cumulative total');
    await advanceResult(page);
    const modalPosition=await page.locator('#questionPosition').innerText(),modalNumber=Number((await page.locator('#questionNumber').innerText()).match(/No\. (\d+)/)[1]),modalTexts=await page.locator('#questionChoices .choice-text').allTextContents(),modalCorrect=modalTexts.indexOf(book('target1900')[modalNumber-1].english);ok(modalCorrect>=0);
    let releaseModal,storedModal;const modalGate=new Promise(resolve=>{releaseModal=resolve;}),modalStored=new Promise(resolve=>{storedModal=resolve;});
    await page.route('**/api/quiz/answer',async route=>{const response=await route.fetch();storedModal();await modalGate;await route.fulfill({response});});
    const modalReply=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/quiz/answer');
    try{await page.locator('#questionChoices button').nth(modalCorrect).click();await modalStored;await page.locator('#quizQuit').click();releaseModal();await modalReply;await page.waitForTimeout(1150);ok(await page.locator('#quitDialog').isVisible(),'A confirmation received behind Quit cannot close the modal or progress');eq(await page.locator('#questionPosition').innerText(),modalPosition);ok(!await page.locator('#quizAdvanceSurface').isVisible());}finally{releaseModal();}
    await page.unroute('**/api/quiz/answer');await page.locator('#quitCancel').click();await waitForResult(page);const resumeTime=Date.now();await page.waitForFunction(old=>document.getElementById('questionPosition').textContent!==old,modalPosition,{timeout:1800});ok(Date.now()-resumeTime>=850,'Cancelling Quit shows a newly acknowledged result for its full interval');
    const shownBeforeLate=await page.evaluate(()=>window.__confirmedCelebrations);
    const lateNumber=Number((await page.locator('#questionNumber').innerText()).match(/No\. (\d+)/)[1]),lateTexts=await page.locator('#questionChoices .choice-text').allTextContents(),lateCorrect=lateTexts.indexOf(book('target1900')[lateNumber-1].english);ok(lateCorrect>=0);
    let releaseLate,lateAccepted;const lateGate=new Promise(resolve=>{releaseLate=resolve;}),lateStored=new Promise(resolve=>{lateAccepted=resolve;});
    await page.route('**/api/quiz/answer',async route=>{const response=await route.fetch();lateAccepted();await lateGate;await route.fulfill({response});});
    const lateReply=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/quiz/answer');
    try{await page.locator('#questionChoices button').nth(lateCorrect).click();await lateStored;ok(!await page.locator('#rewardCelebration').isVisible(),'A later unconfirmed award has no decoration');await page.locator('#quizQuit').click();await page.locator('#quitConfirm').click();await page.locator('#homeView').waitFor({state:'visible'});}finally{releaseLate();}
    await lateReply;await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));ok(!await page.locator('#rewardCelebration').isVisible(),'A late acknowledged reply cannot restore a celebration after leaving the quiz');eq(await page.evaluate(()=>window.__confirmedCelebrations),shownBeforeLate,'A stale response cannot animate another award');
    await page.close();await context.close();await classContext.close();
  });

  await scenario('Home still shows only the leading ten ranks and its ranking button opens every participant',async()=>{
    const fixtures=Array.from({length:11},(_,index)=>({id:uuid(),name:'順位確認'+(index+1),score:20+index,points:20000-index*100}));
    try{
      for(const fixture of fixtures)await targetDb.query('INSERT INTO target_private.profiles(member_id,name,correct_count,answered_count,total_points) VALUES($1,$2,$3,$3,$4)',[fixture.id,fixture.name,fixture.score,fixture.points]);
      const expected=(await target(Guest,'/api/ranking')).ranking,page=await openPage(Guest);await page.waitForFunction(()=>document.getElementById('homeRankingStatus').textContent!=='読み込み中…');
      eq(await page.locator('#homeRankingList > li').count(),10);eq(await page.locator('#homeRankingList .ranking-name').allTextContents(),expected.slice(0,10).map(row=>row.name));eq(await page.locator('#homeRankingList .ranking-score').allTextContents(),expected.slice(0,10).map(row=>row.totalPoints.toLocaleString('ja-JP')+'円'));const fixtureRows=expected.filter(row=>fixtures.some(fixture=>fixture.name===row.name));eq(fixtureRows.map(row=>row.name),fixtures.map(fixture=>fixture.name),'Higher points rank above higher correct-count fixtures');
      await page.locator('#rankingOpen').click();await page.waitForFunction(()=>!document.getElementById('rankingRefresh').disabled);eq(await page.locator('#rankingList > li').count(),expected.length);await page.close();
    }finally{await targetDb.query('DELETE FROM target_private.profiles WHERE member_id=ANY($1::uuid[])',[fixtures.map(fixture=>fixture.id)]);}
  });

  await scenario('Target logout and production asset boundaries keep class credentials private',async()=>{
    await kgs(KgsA,'/api/login',{code:codeChanged,attendanceNumber:1,accountPin:pinNew});await target(A,'/api/logout',{});eq((await target(A,'/api/session')).member,null);eq((await classSession(KgsA)).member.id,memberA.id);
    for(const filename of ['index.html','app.js','style.css','jackpot-effects.js','jackpot-effects.css']){const content=await fs.readFile(path.join(root,'dist',filename),'utf8');for(const secret of [integrationSecret,rpcSecret,cookieSecret,process.env.KGS_ADMIN_SECRET,process.env.KGS_SESSION_SECRET])ok(!content.includes(secret),'Production browser files contain no server secret');}
    const scriptResponse=await Guest.request.get(targetBase+'/server/router.cjs');eq(scriptResponse.status(),404,'Server sources are not static assets');eq(runtimeErrors,[],'Browser has no uncaught errors');
    for(const logs of serverLogs.values())for(const secret of secretSet)ok(!logs.includes(secret),'Runtime logs contain no credential');
  });
}catch(error){failure=error;console.error('E2E ERROR '+redact(error.stack));if(!results.some(r=>r.status==='failed'))results.push({name:'Setup',status:'failed',error:redact(error.message).split('\n')[0]});}
finally{await browser?.close().catch(()=>{});for(const key of [...processes.keys()])await stop(key);await kgsDb.end();await targetDb.end();const report={generatedAt:new Date().toISOString(),environment:'fresh loopback PostgreSQL databases, actual KGS and Target HTTP servers, independent Chromium contexts',cloudVerified:false,physicalSafariVerified:false,externalPushRequests:0,performance:{materialFeedbackMs,guestHundredPreparationMs,actualHttpResponseHeld:true},passed:results.filter(r=>r.status==='passed').length,failed:results.filter(r=>r.status==='failed').length,checks,results};await fs.mkdir(reportDir,{recursive:true});await fs.writeFile(path.join(reportDir,'e2e-results.json'),JSON.stringify(report,null,2)+'\n');console.log(`${report.passed} Target scenarios passed; ${report.failed} failed; ${checks} assertions.`);if(failure)process.exitCode=1;}
})();
