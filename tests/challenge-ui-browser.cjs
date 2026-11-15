'use strict';
// Real public assets, synthetic browser API responses only. No hosted writes.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {chromium,webkit}=require('playwright');
const root=path.resolve(__dirname,'..'),artifactDir=process.env.CHALLENGE_UI_ARTIFACT_DIR||'/workspace/artifacts/challenge-ui';
const visualOnly=process.env.CHALLENGE_UI_VISUAL_ONLY==='1',exitOnly=process.env.CHALLENGE_UI_EXIT_ONLY==='1';
const reportPath=process.env.CHALLENGE_UI_REPORT||path.join(artifactDir,exitOnly?'exit-report.json':visualOnly?'visual-report.json':'report.json');
const liveOrigin=process.env.APP_ORIGIN,origin=liveOrigin||'https://challenge-ui.example/';
const mime={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.mp3':'audio/mpeg','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'};
const id=n=>'00000000-0000-4000-8000-'+n.toString(16).padStart(12,'0');
const deferred=()=>{let release,arrived;return{ready:new Promise(r=>arrived=r),wait:new Promise(r=>release=r),release:()=>release(),arrived:()=>arrived()};};
const copy=x=>structuredClone(x);
let checks=0;const eq=(a,b,label)=>{checks++;assert.deepEqual(a,b,label);};
function fixture(){
 let sequence=100,run=null,signedIn=true,memberIndex=1,unlocked=1,dropAnswer=false,dropAction=null,delayNextResume=false,delayedResume=null,delayNextAbort=false,delayedAbort=null,hold=null,tickEnabled=false;
 const requests=[],cache=new Map(),badges=new Set(),wallet={balance:10000,totalIncome:10000,spent:0,walletRevision:1,gameNet:0};
 const makeQuestion=()=>({id:id(++sequence),number:sequence%100+1,prompt:'achieve',book:['target1900','target1000','kobun400'][sequence%3],choices:Array.from({length:4},(_,i)=>({id:id(++sequence),text:['達成する','避ける','受け取る','認める'][i]}))});
 const makeRun=level=>({id:id(++sequence),level,status:'playing',playerHp:100+50*(level-1),playerMaxHp:100+50*(level-1),enemyHp:100*level,enemyMaxHp:100*level,attackIntervalMs:level===10?1000:2000-100*(level-1),attackDamage:level===10?15:5+level-1,streak:0,correctCount:0,wrongCount:0,questionSequence:1,question:makeQuestion(),nextAttackInMs:level===10?1000:2000-100*(level-1),serverNow:new Date().toISOString(),createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),reward:0,badgeAwarded:false});
 let attackAt=0;
 const tick=()=>{if(!tickEnabled||run?.status!=='playing')return;const now=Date.now();while(now>=attackAt&&run.status==='playing'){run.playerHp=Math.max(0,run.playerHp-run.attackDamage);attackAt+=run.attackIntervalMs;if(!run.playerHp){run.status='lost';run.question=null;}}run.nextAttackInMs=Math.max(0,attackAt-now);};
 const identity=()=>signedIn?{member:{id:id(memberIndex),name:'挑戦テスト'+memberIndex},correctCount:20,totalPoints:wallet.totalIncome,...wallet}:{member:null,correctCount:0,totalPoints:0,balance:0,totalIncome:0,spent:0,walletRevision:0};
 const map=()=>({ok:true,levels:Array.from({length:10},(_,i)=>{const level=i+1;return{level,unlocked:level<=unlocked,cleared:badges.has(level),enemyMaxHp:level*100,playerMaxHp:100+50*i,attackIntervalMs:level===10?1000:2000-100*i,attackDamage:level===10?15:5+i,reward:level*100000,badge:{id:'challenge-level-'+level,name:'挑戦 Lv.'+level,level},clearers:level===1?['最初の勇者','<img src=x>','🚀'.repeat(20)]:level===10?['魔王を倒した人']:[]};}),activeRun:run&&['playing','paused'].includes(run.status)?copy(run):null,wallet:copy(wallet)});
 const snapshot=extra=>({ok:true,run:copy(run),wallet:copy(wallet),...extra});
 async function api(route,u){
  const action=u.pathname.slice('/api/challenge/'.length),input=route.request().method()==='POST'?route.request().postDataJSON():null;
  requests.push({path:u.pathname,action,input:copy(input),at:Date.now()});tick();
  let body,status=200,abort=false;
  if(action==='resume'&&delayNextResume){delayNextResume=false;delayedResume=copy(input);return route.abort('failed');}
  if(action==='abort'&&delayNextAbort){delayNextAbort=false;delayedAbort=copy(input);return route.abort('failed');}
  if(u.pathname==='/api/session'||u.pathname==='/api/login')body=identity();
  else if(u.pathname==='/api/logout'){signedIn=false;body={ok:true};}
  else if(u.pathname==='/api/ranking')body={ranking:[]};
  else if(u.pathname==='/api/mastery'){const total={target1900:1900,target1000:1000,kobun400:400}[u.searchParams.get('book')];body={book:u.searchParams.get('book'),reviewNumbers:[],sections:Array.from({length:total/100},(_,i)=>({section:i+1,from:i*100+1,to:(i+1)*100,total:100,mastered:0,percent:0,reviewCount:0,achievers:[]}))};}
  else if(u.pathname==='/api/battle/lobby')body={ok:true,online:[],ranking:[],incoming:[],outgoing:[],match:null};
  else if(u.pathname.startsWith('/api/challenge/')){
   if(!signedIn){status=401;body={error:{code:'AUTHENTICATION_REQUIRED',message:'ログインしてください。'}};}
   else if(action==='map')body=map();
   else if(action==='state')body=snapshot();
   else if(cache.has(input.requestId)){body={...copy(cache.get(input.requestId)),run:copy(run),wallet:copy(wallet),replayed:true};}
   else if(action==='start'){
    if(input.level>unlocked){status=409;body={error:{code:'CHALLENGE_LOCKED',message:'前のレベルをクリアしてください。'}};}
    else{run=makeRun(input.level);attackAt=Date.now()+run.attackIntervalMs;body=snapshot();}
   }else if(!run||run.id!==input.runId){status=404;body={error:{code:'CHALLENGE_NOT_FOUND',message:'見つかりません。'}};}
   else if(action==='answer'){
    if(run.status!=='playing'){body=snapshot();}
    else{
     assert.equal(input.questionId,run.question.id,'Answer uses current server question');
     const correct=input.choiceId===run.question.choices[0].id;let healedHp=0,enemyHealedHp=0;
     if(correct){run.correctCount++;run.streak++;run.enemyHp=Math.max(0,run.enemyHp-5);if(run.streak%5===0){healedHp=Math.min(10,run.playerMaxHp-run.playerHp);run.playerHp+=healedHp;}}
     else{run.wrongCount++;run.streak=0;run.playerHp=Math.max(0,run.playerHp-10);enemyHealedHp=Math.min(10,run.enemyMaxHp-run.enemyHp);run.enemyHp+=enemyHealedHp;}
     if(!run.enemyHp){run.status='won';run.reward=run.level*100000;run.badgeAwarded=!badges.has(run.level);badges.add(run.level);unlocked=Math.min(10,Math.max(unlocked,run.level+1));wallet.balance+=run.reward;wallet.totalIncome+=run.reward;wallet.walletRevision++;run.question=null;}
     else if(!run.playerHp){run.status='lost';run.question=null;}
     else{run.questionSequence++;run.question=makeQuestion();}
     run.updatedAt=new Date(Date.now()+run.questionSequence).toISOString();body=snapshot({answer:{correct,damage:correct?5:10,healedHp,enemyHealedHp,streakBonus:healedHp>0}});
    }
    if(dropAnswer){dropAnswer=false;abort=true;}
   }else if(action==='pause'){run.nextAttackInMs=Math.max(0,attackAt-Date.now());run.status='paused';run.question=null;body=snapshot();}
   else if(action==='resume'){run.status='playing';run.question=makeQuestion();attackAt=Date.now()+run.nextAttackInMs;body=snapshot();}
   else if(action==='abort'){run.status='aborted';run.question=null;body=snapshot();}
   else throw Error('Unexpected challenge action '+action);
   if(input&&status===200&&!cache.has(input.requestId))cache.set(input.requestId,copy(body));
   if(action===dropAction){dropAction=null;abort=true;}
  }else throw Error('Unexpected API '+u.pathname);
  if(hold&&hold.action===action){const gate=hold;hold=null;gate.arrived();await gate.wait;}
  if(abort)return route.abort('failed');
  return route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
 }
 return{api,requests,identity,map,get run(){return run;},get wallet(){return wallet;},get badges(){return badges;},set unlocked(v){unlocked=v;},set tickEnabled(v){tickEnabled=v;attackAt=Date.now()+(run?.attackIntervalMs||1000);},set dropAnswer(v){dropAnswer=v;},set dropAction(v){dropAction=v;},set delayNextResume(v){delayNextResume=v;},set delayNextAbort(v){delayNextAbort=v;},get delayedAbort(){return delayedAbort;},settleDelayedAbort(){assert(cache.has(delayedAbort.requestId),'Original delayed abort must already have an idempotent receipt');return copy(cache.get(delayedAbort.requestId));},get delayedResume(){return delayedResume;},settleDelayedResume(){assert(cache.has(delayedResume.requestId),'Original delayed resume must already have an idempotent receipt');return snapshot({replayed:true});},set hold(v){hold=v;},set memberIndex(v){memberIndex=v;},set signedIn(v){signedIn=v;},newRun(level){run=makeRun(level);attackAt=Date.now()+run.attackIntervalMs;return run;},resetRun(){run=null;},forceRun(value){Object.assign(run,value);}};
}
async function verify(engine){
 const browser=await(engine==='chromium'?chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']}):webkit.launch({executablePath:'/workspace/scratch/webkit-runtime/pw-run.sh',headless:true}));
 const engineCheckStart=checks;
 const page=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce',hasTouch:true}),errors=[],networkErrors=[],data=fixture();
 try{
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>localStorage.setItem('target-sound-enabled','false'));
  await page.route('**/*',async route=>{
   const u=new URL(route.request().url());
   if(u.pathname.startsWith('/api/')){try{return await data.api(route,u);}catch(e){networkErrors.push(e.message);return route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:{message:e.message}})});}}
   if(liveOrigin)return route.continue();
   const file=path.resolve(root,u.pathname.startsWith('/data/')?'.'+u.pathname:'public'+(u.pathname==='/'?'/index.html':u.pathname));
   if(!file.startsWith(root+path.sep))return route.abort();
   try{return route.fulfill({status:200,contentType:mime[path.extname(file)]||'application/octet-stream',body:await fs.readFile(file)});}catch{return route.fulfill({status:404,body:'missing fixture'});}
  });
  await page.goto(origin);await page.waitForFunction(()=>document.querySelector('#accountBadge').textContent==='挑戦テスト1');
  const tile=level=>page.locator('.challenge-tile[data-level="'+level+'"]');
  const enemyHp=()=>page.locator('.challenge-health-enemy [role=progressbar]').getAttribute('aria-valuenow').then(Number);
  const playerHp=()=>page.locator('.challenge-health-player [role=progressbar]').getAttribute('aria-valuenow').then(Number);
  const lastRequest=action=>data.requests.filter(r=>r.action===action).at(-1);
  async function map(){await page.locator('#challengeOpen').click();await page.locator('.challenge-map').waitFor({state:'visible'});await page.waitForFunction(()=>document.querySelectorAll('.challenge-tile').length===10);}
  async function start(level){await tile(level).click();await page.locator('#challengePrompt').waitFor({state:'visible'});await page.waitForFunction(n=>document.querySelector('.challenge-game-header .challenge-eyebrow').textContent==='LEVEL '+String(n).padStart(2,'0'),level);}
  async function answer(index=0){const before=data.requests.filter(r=>r.action==='answer').length;await page.locator('.challenge-choice').nth(index).click();await page.waitForFunction(()=>!document.querySelector('.challenge-choice:disabled')||!!document.querySelector('.challenge-result'));eq(data.requests.filter(r=>r.action==='answer').length,before+1,'One tap sends one answer');}
  async function sync(){await page.evaluate(()=>window.TargetChallengeUI.refresh());await page.waitForTimeout(50);}
  async function pause(){await page.locator('#challengePause').click();await page.getByRole('heading',{name:'PAUSED',exact:true}).waitFor();}
  async function home(){await page.locator('#challengeHome').click();await page.locator('#homeView').waitFor({state:'visible'});}
  async function back(){await page.getByRole('button',{name:'戻る',exact:true}).click();await page.locator('.challenge-map').waitFor();}
  async function screenshot(name){await page.screenshot({path:path.join(artifactDir,engine+'-'+name+'.png'),fullPage:true});}
  async function fits(label){eq(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,label);}
  if(exitOnly){
   const startingWallet=copy(data.wallet);data.unlocked=10;await map();await sync();eq(await page.title(),'挑戦 | 暗記','Challenge title uses 暗記 suffix');
   await start(1);const firstRun=data.run.id;await pause();const firstExit=data.requests.length;await home();
   eq(data.requests.slice(firstExit).filter(r=>['pause','abort'].includes(r.action)).map(r=>r.action),['abort'],'A confirmed pause exits through server abort');eq(data.run.status,'aborted','Home ends the active attempt');eq(await page.locator('#challengeApp').textContent(),'','Home clears complete challenge DOM');
   await map();eq(await page.locator('.challenge-map').isVisible(),true,'Reopening Home returns the stage map');await start(2);eq(data.run.id===firstRun,false,'A different level starts a fresh attempt');eq(data.run.level,2);
   // Backgrounding retains a covered pause. Only explicit Home aborts it.
   const abortsBeforeHidden=data.requests.filter(r=>r.action==='abort').length;await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});await page.getByRole('heading',{name:'PAUSED',exact:true}).waitFor();eq(data.run.status,'paused','Visibility-only exit keeps run paused');eq(data.requests.filter(r=>r.action==='abort').length,abortsBeforeHidden,'Backgrounding does not abort');await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});
   // Resolve an uncertain resume receipt before pause and terminal exit.
   data.dropAction='resume';await page.locator('#challengeResume').click();await page.locator('#challengeStatus').waitFor({state:'visible'});const resumeInput=copy(lastRequest('resume').input),resumeExit=data.requests.length;await home();const resumeActions=data.requests.slice(resumeExit).filter(r=>['resume','pause','abort'].includes(r.action));eq(resumeActions.map(r=>r.action),['resume','pause','abort'],'Home resolves resume, pauses, then aborts');eq(resumeActions[0].input,resumeInput,'Home reuses uncertain resume UUID');eq(data.run.status,'aborted');
   // A start acknowledged only by storage is recovered before Home abandons it.
   await map();data.dropAction='start';await tile(3).click();await page.locator('#challengeStatus').waitFor({state:'visible'});const startInput=copy(lastRequest('start').input),startExit=data.requests.length;await page.evaluate(()=>window.TargetChallengeUI.leaveHome());await page.locator('#homeView').waitFor({state:'visible'});const startActions=data.requests.slice(startExit).filter(r=>['start','pause','abort'].includes(r.action));eq(startActions.map(r=>r.action),['start','pause','abort'],'Home resolves uncertain start, pauses, then aborts');eq(startActions[0].input,startInput,'Home reuses uncertain start UUID');eq(data.run.status,'aborted');
   // The server committed abort, but its acknowledgement was lost.
   await map();await start(2);await pause();data.dropAction='abort';await page.locator('#challengeHome').click();await page.locator('#challengeStatus').waitFor({state:'visible'});const committedAbort=copy(lastRequest('abort').input);eq(data.run.status,'aborted','Dropped acknowledgement can follow a committed abort');eq(await page.locator('#homeView').isVisible(),false,'Home waits for terminal abort acknowledgement');eq(await page.locator('#challengeResume').textContent(),'再接続','Pending exit offers reconnection');eq((await page.locator('#challengeQuestionRegion').innerText()).includes('続ける'),false,'Pending exit never offers Continue');eq(await page.locator('#challengePrompt').count(),0);eq(await page.locator('.challenge-choice').count(),0);await screenshot('exit-pending');await page.locator('#challengeResume').click();await page.locator('#homeView').waitFor({state:'visible'});eq(lastRequest('abort').input,committedAbort,'Committed abort retry preserves exact UUID');
   await map();await start(1);const newAfterAbort=data.run.id;eq(newAfterAbort===committedAbort.runId,false,'Confirmed abort allows a new attempt');await pause();
   // First abort has not reached storage when the client loses its response.
   data.delayNextAbort=true;await page.locator('#challengeHome').click();await page.locator('#challengeStatus').waitFor({state:'visible'});const uncommittedAbort=copy(data.delayedAbort);eq(data.run.status,'paused','Delayed abort leaves storage paused until retry');eq(await page.locator('#challengeResume').textContent(),'再接続');eq((await page.locator('#challengeQuestionRegion').innerText()).includes('続ける'),false);await page.locator('#challengeResume').click();await page.locator('#homeView').waitFor({state:'visible'});eq(lastRequest('abort').input,uncommittedAbort,'Uncommitted abort retry preserves exact UUID');eq(data.run.status,'aborted');
   await map();await start(3);const finalRun=data.run.id;data.settleDelayedAbort();eq(data.run.id,finalRun,'Late original abort receipt cannot replace the fresh run');eq(data.run.status,'playing','Late abort cannot stop the next attempt');eq(await page.locator('.challenge-game-header .challenge-eyebrow').textContent(),'LEVEL 03');
   // A delayed abort snapshot belonging to another account cannot resurrect a view.
   await pause();const staleAbort=deferred();data.hold={...staleAbort,action:'abort'};await page.locator('#challengeHome').click();await staleAbort.ready;await page.locator('#settingsOpen').evaluate(n=>n.click());await page.locator('#logoutButton').click();await page.locator('#loginForm').waitFor({state:'visible'});await page.locator('#settingsClose').click();data.memberIndex=2;data.signedIn=true;data.resetRun();await page.locator('#settingsOpen').click();await page.waitForFunction(()=>document.querySelector('#accountBadge').textContent==='挑戦テスト2');await page.locator('#settingsClose').click();await map();staleAbort.release();await page.waitForTimeout(80);eq(await page.locator('.challenge-map').isVisible(),true,'Late old-account abort cannot replace new map');eq(await page.locator('#challengePrompt').count(),0);eq(await page.locator('.challenge-result').count(),0,'Late abort cannot show DEFEAT');
   eq(data.wallet,startingWallet,'Abandoning attempts creates no reward or refund');eq(data.badges.size,0,'Abandoning creates no badge');eq(data.requests.filter(r=>r.action==='answer').length,0,'Exit controls submit no answers');eq(errors,[],'No browser runtime errors');eq(networkErrors,[],'All fixture routes matched');
   return{engine,passed:true,checks:checks-engineCheckStart,exitOnly:true,cases:['home-reopen-new-level','visibility-pause-only','lost-resume-home','lost-start-home','lost-abort-committed','lost-abort-uncommitted','late-abort-new-run','late-abort-new-account']};
  }
  if(visualOnly){
   await map();eq((await page.locator('#challengeApp').textContent()).includes('TARGET QUEST'),false,'Map has no extra branding');
   for(const width of[320,390,1024]){await page.setViewportSize({width,height:width===1024?900:844});await fits('Map fits'+width+'px');await screenshot('map-'+width);}
   const sceneURLs=await page.locator('.challenge-tile-art').evaluateAll(nodes=>nodes.map(n=>n.style.backgroundImage));
   data.unlocked=10;await sync();const allLevelArt=[];
   for(let level=1;level<=10;level++){
    await start(level);const scene=await page.locator('#challengeArena').evaluate(n=>n.style.backgroundImage);
    eq(scene,sceneURLs[level-1],'Level'+level+' arena matches tile');eq(await page.evaluate(()=>getComputedStyle(document.body).backgroundImage.includes(document.body.style.getPropertyValue('--challenge-scene'))),true,'Level'+level+' scene fills body');
    allLevelArt.push({level,tileArenaBodyMatch:true});
    if(level===1||level===10){
     for(const width of[320,390,1024]){await page.setViewportSize({width,height:width===1024?900:844});await fits('Level'+level+' fits'+width+'px');await screenshot('level'+level+'-playing'+(width===390?'':'-'+width));}
    }
    await page.setViewportSize({width:390,height:844});
    if(level===1){
     const prompt=await page.locator('#challengePrompt').textContent();await pause();eq(await page.locator('#challengePrompt').count(),0);eq(await page.locator('.challenge-choice').count(),0);
     const pauseStyleFinal=await page.locator('.challenge-pause-panel').evaluate(n=>({background:getComputedStyle(n).backgroundColor,opacity:getComputedStyle(n).opacity,filter:getComputedStyle(n).filter}));eq(pauseStyleFinal,{background:'rgb(242, 239, 229)',opacity:'1',filter:'none'},'Pause stays opaque over full stage scene');eq((await page.locator('#challengeQuestionRegion').ariaSnapshot()).includes(prompt),false,'No prompt in paused accessibility tree');
     for(const width of[320,390]){await page.setViewportSize({width,height:844});await fits('Paused stage fits'+width+'px');await screenshot('paused'+(width===390?'':'-'+width));}
    }else if(level===10){
     data.forceRun({enemyHp:5});await sync();await answer();await page.getByRole('heading',{name:'VICTORY!',exact:true}).waitFor();await screenshot('level10-victory-badge');await back();await start(1);data.forceRun({playerHp:10,enemyHp:95});await sync();await answer(1);await page.getByRole('heading',{name:'DEFEAT',exact:true}).waitFor();await page.waitForFunction(()=>document.querySelector('.challenge-clearers').textContent.includes('最初の勇者'));await screenshot('defeat');eq((await page.locator('.challenge-result').textContent()).includes('次の挑戦へ'),false,'Defeat has no extra instruction copy');await back();break;
    }else await pause();
    await home();data.resetRun();await map();
   }
   eq(errors,[],'No browser runtime errors');eq(networkErrors,[],'All fixture routes matched');return{engine,passed:true,checks:checks-engineCheckStart,visualOnly:true,allLevelArt};
  }
  await map();
  eq(await page.locator('.challenge-tile').count(),10,'Map has ten stages');
  eq(await tile(1).isEnabled(),true,'Level1 unlocked');eq(await page.locator('.challenge-tile:disabled').count(),9,'Later levels locked');
  eq(await tile(10).getAttribute('aria-label'),'Lv.10 魔王城 ロック中','Level10 has demon castle label');
  await tile(10).evaluate(n=>n.click());eq(data.requests.filter(r=>r.action==='start').length,0,'Locked tile cannot start via click');
  const sceneURLs=await page.locator('.challenge-tile-art').evaluateAll(nodes=>nodes.map(n=>n.style.backgroundImage));
  eq(sceneURLs.every(Boolean),true,'Every stage has actual scene art');eq(new Set(sceneURLs).size,10,'Ten distinct scene illustrations');
  await fits('Map fits390px');await screenshot('map-390');
  await page.setViewportSize({width:320,height:780});await fits('Map fits320px');await screenshot('map-320');
  await page.setViewportSize({width:1024,height:900});await fits('Map fits1024px');await screenshot('map-1024');
  await page.setViewportSize({width:390,height:844});
  await start(1);eq(await enemyHp(),100);eq(await playerHp(),100);eq(await page.locator('#challengeArena').evaluate(n=>n.style.backgroundImage),sceneURLs[0],'Playing background matches tile');
  eq(await page.locator('#challengeMob svg').count(),1,'Enemy illustration is rendered');await screenshot('level1-playing');
  await page.setViewportSize({width:320,height:780});await fits('Gameplay fits320px');await screenshot('level1-playing-320');await page.setViewportSize({width:1024,height:900});await fits('Gameplay fits1024px');await screenshot('level1-playing-1024');await page.setViewportSize({width:390,height:844});
  data.forceRun({playerHp:80});await sync();
  const keyCount=data.requests.filter(r=>r.action==='answer').length;await page.locator('.challenge-choice').first().focus();await page.keyboard.down('Enter');await page.waitForFunction(()=>document.querySelector('.challenge-health-enemy [role=progressbar]').getAttribute('aria-valuenow')==='95');await page.keyboard.up('Enter');await page.waitForTimeout(40);eq(data.requests.filter(r=>r.action==='answer').length,keyCount+1,'Keyboard release does not answer the next question');
  for(let i=0;i<4;i++)await answer();
  eq(await enemyHp(),75,'Five correct answers damage enemy25');eq(await playerHp(),90,'Five-answer combo heals10');
  await answer(1);eq(await playerHp(),80,'Wrong answer costs10HP');eq(await enemyHp(),85,'Wrong answer heals enemy10');
  eq(data.run.streak,0,'Wrong answer resets combo');
  eq(await page.locator('#challengeMob').evaluate(n=>getComputedStyle(n).animationName),'none','Reduced motion disables hit animation');
  const tapCount=data.requests.filter(r=>r.action==='answer').length;await page.locator('.challenge-choice').first().tap();await page.waitForFunction(()=>!document.querySelector('.challenge-choice:disabled'));eq(data.requests.filter(r=>r.action==='answer').length,tapCount+1,'Touch tap answers once');
  // Lost response: the server accepted it; an explicit retry must retain all ids.
  data.dropAnswer=true;await page.locator('.challenge-choice').first().click();await page.locator('.challenge-answer-retry').waitFor({state:'visible'});
  const lost=copy(lastRequest('answer').input),hpAfterLost=data.run.enemyHp;
  await page.locator('.challenge-answer-retry').click();await page.waitForFunction(()=>!document.querySelector('.challenge-choice:disabled'));
  eq(lastRequest('answer').input,lost,'Lost answer acknowledgement retries exact operation');eq(data.run.enemyHp,hpAfterLost,'Retry produces no second damage');
  const pausedPrompt=await page.locator('#challengePrompt').textContent(),pausedChoices=await page.locator('.challenge-choice').allTextContents();
  const pauseGate=deferred();data.hold={...pauseGate,action:'pause'};
  await page.locator('#challengePause').click();await pauseGate.ready;
  eq(await page.locator('#challengePrompt').count(),0,'Prompt removed immediately before pause acknowledgement');eq(await page.locator('.challenge-choice').count(),0,'Choices removed immediately before pause acknowledgement');
  eq((await page.locator('#challengeQuestionRegion').innerText()).includes(pausedPrompt),false,'Pause hides prompt in DOM text');
  const pauseStyle=await page.locator('.challenge-pause-panel').evaluate(n=>({background:getComputedStyle(n).backgroundColor,opacity:getComputedStyle(n).opacity,filter:getComputedStyle(n).filter}));
  eq(pauseStyle,{background:'rgb(242, 239, 229)',opacity:'1',filter:'none'},'Pause panel is opaque without blur');
  const aria=await page.locator('#challengeQuestionRegion').ariaSnapshot();eq(aria.includes(pausedPrompt),false,'Prompt absent from accessibility tree');for(const choice of pausedChoices)eq(aria.includes(choice),false,'Choice absent from accessibility tree');
  pauseGate.release();await page.getByRole('heading',{name:'PAUSED',exact:true}).waitFor();
  const frozenHp=data.run.playerHp,statesBefore=data.requests.filter(r=>r.action==='state').length;
  data.tickEnabled=true;await page.waitForTimeout(1200);await sync();eq(data.run.playerHp,frozenHp,'Paused mock server does not tick');eq(await playerHp(),frozenHp,'Paused HP remains frozen');data.tickEnabled=false;
  await screenshot('paused');
  await page.locator('#challengeResume').click();await page.locator('#challengePrompt').waitFor({state:'visible'});eq(await page.locator('.challenge-choice').count(),4,'Resume restores four server choices');
  eq(data.requests.filter(r=>r.action==='state').length>=statesBefore,true);
  // A held playing snapshot must not reveal its question after stop is pressed.
  const staleState=deferred();data.hold={...staleState,action:'state'};
  void page.evaluate(()=>window.TargetChallengeUI.refresh());await staleState.ready;
  await page.locator('#challengePause').click();eq(await page.locator('.challenge-choice').count(),0);staleState.release();
  await page.getByRole('heading',{name:'PAUSED',exact:true}).waitFor();eq(await page.locator('#challengePrompt').count(),0,'Late playing state cannot undo pause intention');
  // Resume accepted by server but its response lost: Home must pause that server run.
  data.dropAction='resume';await page.locator('#challengeResume').click();await page.locator('#challengeStatus').waitFor({state:'visible'});eq(data.run.status,'playing','Lost resume response has already resumed server');
  await home();eq(data.run.status,'aborted','Home confirms abort after resolving lost resume response');eq(await page.locator('#challengeApp').textContent(),'','Going home clears the complete challenge DOM');
  // Reopening a prior run always enters a covered pause, and home/real-time navigation still works.
  data.newRun(1);data.forceRun({status:'paused',question:null});await page.locator('#challengeOpen').click();await page.getByRole('heading',{name:'PAUSED',exact:true}).waitFor();eq(await page.locator('.challenge-choice').count(),0,'A recovered active run starts paused');
  const hiddenResume=deferred();data.hold={...hiddenResume,action:'resume'};await page.locator('#challengeResume').click();await hiddenResume.ready;await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});hiddenResume.release();await page.getByRole('heading',{name:'PAUSED',exact:true}).waitFor();eq(await page.locator('.challenge-choice').count(),0,'Backgrounding an in-flight resume cannot expose a question');await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});
  // Original resume has not reached storage when client loses its connection.
  data.delayNextResume=true;await page.locator('#challengeResume').click();await page.locator('#challengeStatus').waitFor({state:'visible'});const delayedResume=copy(data.delayedResume),delayedStart=data.requests.length;
  eq(data.run.status,'paused','Delayed original resume has not committed');await home();
  const delayedActions=data.requests.slice(delayedStart).filter(r=>['resume','pause','abort'].includes(r.action));eq(delayedActions.map(r=>r.action),['resume','pause','abort'],'Home resolves uncertain resume receipt, pauses, then aborts');eq(delayedActions[0].input,delayedResume,'Uncertain resume retry preserves exact request UUID');
  data.settleDelayedResume();eq(data.run.status,'aborted','Late original resume receipt cannot restart aborted run offscreen');

  await page.locator('#battleOpen').click();await page.locator('#battleView').waitFor({state:'visible'});await page.locator('#battleView [data-home]').click();await page.locator('#homeView').waitFor({state:'visible'});
  data.resetRun();data.unlocked=10;
  // Check every actual arena uses exactly its corresponding map illustration.
  const allLevelArt=[];
  for(let level=1;level<=10;level++){
   await map();await start(level);const background=await page.locator('#challengeArena').evaluate(n=>n.style.backgroundImage);
   eq(background,sceneURLs[level-1],'Level'+level+' background matches map');eq(await enemyHp(),level*100);eq(await playerHp(),100+50*(level-1));
   allLevelArt.push({level,backgroundPresent:!!background,mobSVG:await page.locator('#challengeMob svg').count()});
   if(level===10){await screenshot('level10-playing');eq(data.run.attackIntervalMs,1000);eq(data.run.attackDamage,15);}
   await pause();await home();data.resetRun();
  }
  // Final hit with a lost acknowledgement must award one wallet event and badge.
  await map();data.dropAction='start';await tile(10).click();await page.locator('#challengeStatus').waitFor({state:'visible'});const lostStart=copy(lastRequest('start').input),lostStartRun=data.run.id;await page.locator('.challenge-retry').click();await page.locator('#challengePrompt').waitFor();eq(lastRequest('start').input,lostStart,'Lost initial start receipt retries same UUID');eq(data.run.id,lostStartRun,'Initial start retry recovers the same run');data.forceRun({enemyHp:5});await sync();data.dropAnswer=true;
  await page.locator('.challenge-choice').first().click();await page.locator('.challenge-answer-retry').waitFor();const winRequest=copy(lastRequest('answer').input),rewardedWallet=copy(data.wallet);
  await page.locator('.challenge-answer-retry').click();await page.getByRole('heading',{name:'VICTORY!',exact:true}).waitFor();
  eq(lastRequest('answer').input,winRequest,'Win acknowledgement retry retains requestId');eq(data.wallet,rewardedWallet,'Duplicate win retry cannot inflate wallet');eq(data.badges.size,1,'Only one unique badge');
  eq(await page.locator('.challenge-reward').textContent(),'+1,000,000轟');eq(await page.locator('.challenge-earned').textContent(),'新しい紋章を獲得');
  await page.waitForFunction(()=>document.querySelector('.challenge-clearers').textContent.includes('魔王を倒した人'));await screenshot('level10-victory-badge');
  eq(await page.locator('.challenge-result-art svg').count(),1,'Victory displays rendered badge');
  // A repeat started from a terminal result may commit despite a lost response.
  data.dropAction='start';await page.getByRole('button',{name:'もう一度',exact:true}).click();await page.locator('#challengeStatus').waitFor({state:'visible'});const repeatStart=copy(lastRequest('start').input),repeatRun=data.run.id;eq(data.run.status,'playing','Lost repeat-start response already started server');
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});await page.getByRole('heading',{name:'PAUSED',exact:true}).waitFor();eq(lastRequest('start').input,repeatStart,'Hidden repeat resolves original start UUID');eq(data.run.id,repeatRun,'Hidden repeat cannot create an extra run');eq(data.run.status,'paused','Hidden repeat pauses newly recovered run');eq(await page.locator('.challenge-choice').count(),0,'Hidden repeat cannot expose new choices');
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});await home();data.resetRun();await map();eq(await tile(10).locator('.challenge-tile-badge svg').count(),1,'Cleared tile displays acquired badge');
  // Defeat has actual clearer names rendered safely, retry, and back-to-map.
  await start(1);data.forceRun({playerHp:10,enemyHp:95});await sync();await answer(1);await page.getByRole('heading',{name:'DEFEAT',exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelector('.challenge-clearers').textContent.includes('最初の勇者'));
  eq(await page.locator('.challenge-clearers li').allTextContents(),['最初の勇者','<img src=x>','🚀'.repeat(20)]);eq(await page.locator('.challenge-clearers img').count(),0,'Clearer names are inert text');await fits('Defeat and long names fit390px');await screenshot('defeat');
  await page.getByRole('button',{name:'リトライ',exact:true}).click();await page.locator('#challengePrompt').waitFor();eq(await playerHp(),100,'Retry creates fresh HP');
  // Logout clears DOM and ignores an in-flight answer snapshot belonging to old account.
  const logoutGate=deferred();data.hold={...logoutGate,action:'answer'};await page.locator('.challenge-choice').first().click();await logoutGate.ready;
  await page.locator('#settingsOpen').evaluate(n=>n.click());await page.locator('#logoutButton').click();await page.locator('#loginForm').waitFor({state:'visible'});await page.locator('#settingsClose').click();
  eq(await page.locator('#challengeApp').textContent(),'','Logout discards old challenge DOM and pending result');eq(await page.locator('#homeView').isVisible(),true);
  data.memberIndex=2;data.signedIn=true;data.resetRun();await page.locator('#settingsOpen').click();await page.waitForFunction(()=>document.querySelector('#accountBadge').textContent==='挑戦テスト2');await page.locator('#settingsClose').click();await map();logoutGate.release();await page.waitForTimeout(100);eq(await page.locator('#challengePrompt').count(),0,'Late old-account answer cannot replace new-account map');eq(await page.locator('.challenge-map').isVisible(),true);
  await fits('Final map remains responsive');
  eq(errors,[],'No browser runtime errors');eq(networkErrors,[],'All fixture routes matched');
  return{engine,passed:true,checks:checks-engineCheckStart,allLevelArt,apiRequests:data.requests.length};
 }finally{await browser.close();}
}
(async()=>{await fs.mkdir(artifactDir,{recursive:true});const results=[];for(const engine of(process.env.CHALLENGE_UI_ENGINES||'chromium,webkit').split(','))results.push(await verify(engine));const productHashes={};for(const file of['public/challenge.js','public/challenge.css','public/challenge-art.js','public/app.js','public/index.html'])productHashes[file]=crypto.createHash('sha256').update(await fs.readFile(path.join(root,file))).digest('hex');const report={passed:true,checks,visualOnly,exitOnly,results,hostedAuthenticatedRequests:0,hostedAPIRequests:0,artifactDir,productHashes};await fs.writeFile(reportPath,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));})().catch(async error=>{await fs.mkdir(artifactDir,{recursive:true});await fs.writeFile(reportPath,JSON.stringify({passed:false,checks,error:error.stack},null,2)+'\n');console.error(error);process.exitCode=1;});
