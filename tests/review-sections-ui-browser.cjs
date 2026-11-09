'use strict';
// Browser UI integration with synthetic local API responses only. When an
// APP_ORIGIN is supplied, public static assets are real; no hosted API runs.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium,webkit}=require('playwright');
const root=path.resolve(__dirname,'..'),liveOrigin=process.env.APP_ORIGIN,origin=liveOrigin||'https://review-sections.example/';
const artifactDir=process.env.REVIEW_SECTIONS_ARTIFACT_DIR||'/workspace/artifacts/review-sections-ui';
const reportPath=process.env.REVIEW_SECTIONS_REPORT||'/workspace/scratch/review-sections-ui-results.json';
const totals={target1900:1900,target1000:1000,kobun400:400};
const id=n=>'00000000-0000-4000-8000-'+n.toString(16).padStart(12,'0');
const identity={member:{id:id(1),name:'解き直し確認'},correctCount:200,totalPoints:10000,balance:10000,totalIncome:10000,spent:0,walletRevision:1};
const mime={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.mp3':'audio/mpeg','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'};
const deferred=()=>{let arrived,release;return{ready:new Promise(r=>arrived=r),wait:new Promise(r=>release=r),arrived:()=>arrived(),release:()=>release()};};
let checks=0;
const eq=(a,b,label)=>{checks++;assert.deepEqual(a,b,label);};
async function verify(engine){
 const launchProxy=liveOrigin&&(process.env.HTTPS_PROXY||process.env.https_proxy)?{proxy:{server:process.env.HTTPS_PROXY||process.env.https_proxy}}:{};
 const browser=await(engine==='chromium'?chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox'],...launchProxy}):webkit.launch({executablePath:'/workspace/scratch/webkit-runtime/pw-run.sh',headless:true,...launchProxy}));
 const page=await browser.newPage({viewport:{width:320,height:780},reducedMotion:'reduce'}),errors=[],starts=[],requests=[];
 const reviews={target1900:[1,101,102,1900],target1000:[100,1000],kobun400:[1,201,400]};
 let signedIn=true,nextFailure=false,held,sequence=30;
 const snapshot=book=>({book,reviewNumbers:reviews[book],sections:Array.from({length:totals[book]/100},(_,i)=>({section:i+1,from:i*100+1,to:(i+1)*100,total:100,mastered:0,percent:0,reviewCount:reviews[book].filter(n=>n>i*100&&n<=(i+1)*100).length,achievers:[]}))});
 const question=number=>({id:id(++sequence),number,prompt:'問題 '+number,choices:Array.from({length:4},(_,i)=>({id:id(++sequence),text:'選択肢 '+i}))});
 try{
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>localStorage.setItem('target-sound-enabled','false'));
  await page.route('**/*',async route=>{
   const u=new URL(route.request().url());requests.push(u.pathname);
   if(u.pathname.startsWith('/api/')){
    let body,status=200;
    if(u.pathname==='/api/session'||u.pathname==='/api/login')body=signedIn?identity:{member:null,correctCount:0,totalPoints:0,balance:0,totalIncome:0,spent:0};
    else if(u.pathname==='/api/logout'){signedIn=false;body={ok:true};}
    else if(u.pathname==='/api/ranking')body={ranking:[]};
    else if(u.pathname==='/api/mastery')body=snapshot(u.searchParams.get('book'));
    else if(u.pathname==='/api/quiz/review/start'||u.pathname==='/api/quiz/start'){
     const input=route.request().postDataJSON();starts.push({path:u.pathname,input});
     if(nextFailure){nextFailure=false;status=503;body={error:{code:'STORAGE_UNAVAILABLE',message:'仮の通信失敗'}};}
     else{
      const pool=u.pathname==='/api/quiz/review/start'?reviews[input.book].filter(n=>n>=input.from&&n<=input.to):[input.from];
      if(!pool.length){status=409;body={error:{code:'REVIEW_EMPTY',message:'この範囲に解き直す単語はありません。'}};}
      else body={quizId:id(++sequence),total:Math.min(input.count,pool.length),answeredCount:0,correctCount:0,quizPoints:0,question:question(pool[0]),bonus:null};
     }
     if(held){const gate=held;held=null;gate.arrived();await gate.wait;}
    }else throw Error('Unexpected API '+u.pathname);
    return route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
   }
   if(liveOrigin)return route.continue();
   const file=path.resolve(root,u.pathname.startsWith('/data/')?'.'+u.pathname:'public'+(u.pathname==='/'?'/index.html':u.pathname));
   if(!file.startsWith(root+path.sep))return route.abort();
   try{return await route.fulfill({status:200,contentType:mime[path.extname(file)]||'application/octet-stream',body:await fs.readFile(file)});}catch{return route.fulfill({status:404,body:'missing fixture'});}
  });
  async function ready(){await page.waitForFunction(()=>document.getElementById('accountBadge').textContent==='解き直し確認');}
  async function home(){await page.locator('#setupView [data-home]').click();await page.locator('#homeView').waitFor({state:'visible'});}
  async function openReview(){await page.locator('#reviewOpen').click();await page.locator('#setupView').waitFor({state:'visible'});eq(await page.locator('#setupTitle').textContent(),'解き直し');}
  async function setRange(from,to){await page.locator('#rangeFrom').selectOption(String(from));await page.locator('#rangeTo').selectOption(String(to));}
  async function range(from,to){eq(await page.locator('#rangeFrom').inputValue(),String(from));eq(await page.locator('#rangeTo').inputValue(),String(to));}
  async function begin(){await page.locator('#testStart').click();await page.locator('#quizView').waitFor({state:'visible'});}
  async function quit(){await page.locator('#quizQuit').click();await page.locator('#quitConfirm').click();await page.locator('#homeView').waitFor({state:'visible'});}
  async function homeCount(value){await page.waitForFunction(v=>document.getElementById('homeReviewCount').textContent===v,value);checks++;}
  function lastStart(){return starts.at(-1).input;}
  await page.goto(origin);await ready();await homeCount('4個');
  await page.locator('#homeSectionFrom').selectOption('2');await page.locator('#homeSectionTo').selectOption('3');
  await page.locator('#testOpen').click();await range(2,3);await home();
  await openReview();await range(1,19);eq((await page.locator('#reviewNotice').textContent()).includes('全Section'),true);eq(await page.locator('#testSectionRange').isVisible(),true);eq(await page.locator('#rangeFrom').isEnabled(),true);eq(await page.locator('#rangeTo').isEnabled(),true);
  eq(await page.locator('#rangeFrom option').count(),19);eq(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Section controls fit320px');
  await setRange(2,2);eq((await page.locator('#reviewNotice').textContent()).includes('Section 2にある'),true);await begin();eq(starts.at(-1).path,'/api/quiz/review/start');eq({...lastStart(),requestId:undefined},{book:'target1900',direction:'english',count:10,from:101,to:200,requestId:undefined});eq(await page.locator('#questionNumber').textContent(),'No. 101');eq(await page.locator('#questionPosition').textContent(),'1 / 2問');await quit();
  await homeCount('4個');eq(await page.locator('#homeSectionFrom').inputValue(),'2');eq(await page.locator('#homeSectionTo').inputValue(),'3');
  await openReview();await range(2,2);await page.locator('#questionCount').selectOption('100');await page.locator('input[name=direction][value=japanese]').check();await begin();eq(lastStart().count,100);eq(lastStart().direction,'japanese');eq([lastStart().from,lastStart().to],[101,200]);await quit();

  await openReview();await setRange(3,3);await page.locator('#testStart').click();await page.locator('#setupError').waitFor({state:'visible'});eq([lastStart().from,lastStart().to],[201,300]);eq(await page.locator('#quizView').isVisible(),false);eq(await page.locator('#testStart').isEnabled(),true,'Empty Section remains selectable');
  await setRange(2,2);eq(await page.locator('#setupError').isVisible(),false,'Changing range clears the old empty-range error');
  nextFailure=true;await page.locator('#testStart').click();await page.locator('#setupError').waitFor({state:'visible'});const failed=structuredClone(lastStart());await begin();eq(lastStart(),failed,'Transport retry preserves exact range and idempotency key');await quit();
  await openReview();nextFailure=true;await page.locator('#testStart').click();await page.locator('#setupError').waitFor({state:'visible'});const abandoned=structuredClone(lastStart());await setRange(19,19);await begin();eq([lastStart().from,lastStart().to],[1801,1900]);eq(lastStart().requestId===abandoned.requestId,false,'A changed range starts a new operation');eq(await page.locator('#questionNumber').textContent(),'No. 1900');await quit();

  await openReview();await setRange(2,2);const gate=deferred();held=gate;await page.locator('#testStart').click();await gate.ready;await setRange(19,19);gate.release();await page.waitForFunction(()=>!document.getElementById('testStart').disabled);eq(await page.locator('#setupView').isVisible(),true,'A late start cannot replace a changed review selection');await begin();eq([lastStart().from,lastStart().to],[1801,1900]);await quit();

  for(const[book,max,totalCount]of[['target1000',10,'2個'],['kobun400',4,'3個']]){
   await page.locator('#bookSelect').selectOption(book);await homeCount(totalCount);await openReview();await range(1,max);eq(await page.locator('#rangeFrom option').count(),max);await setRange(max,max);await begin();eq(lastStart().book,book);eq([lastStart().from,lastStart().to],[(max-1)*100+1,max*100]);eq(await page.locator('#questionNumber').textContent(),'No. '+totals[book]);await quit();
   eq(await page.locator('#homeSectionFrom').inputValue(),'1');eq(await page.locator('#homeSectionTo').inputValue(),'1');await openReview();await range(max,max);await home();
  }
  await page.locator('#bookSelect').selectOption('target1900');await homeCount('4個');await openReview();await range(19,19);await page.screenshot({path:path.join(artifactDir,engine+'-review-sections.png'),fullPage:false});
  await home();await page.locator('#settingsOpen').click();await page.locator('#logoutButton').click();await page.locator('#loginForm').waitFor({state:'visible'});await page.locator('#settingsClose').click();await openReview();eq(await page.locator('#testStart').isDisabled(),true);eq(await page.locator('#reviewLogin').isVisible(),true);eq((await page.locator('#reviewNotice').textContent()).includes('ログイン'),true);
  eq(errors,[],'No browser runtime errors');eq(requests.filter(p=>p==='/api/quiz/answer').length,0,'No synthetic start submits any answer');
  return{engine,passed:true,checks,starts:starts.length,publicAssets:!!liveOrigin};
 }finally{await browser.close();}
}
(async()=>{await fs.mkdir(artifactDir,{recursive:true});const results=[];for(const engine of['chromium','webkit'])results.push(await verify(engine));const report={status:'passed',checks,results,hostedAuthenticatedRequests:0,hostedAPIRequests:0};await fs.writeFile(reportPath,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));})().catch(error=>{console.error(error);process.exitCode=1;});
