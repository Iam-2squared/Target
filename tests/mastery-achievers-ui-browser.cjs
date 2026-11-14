'use strict';
// Synthetic browser responses only. No hosted identities or stored answers.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium,webkit}=require('playwright');
const root=path.resolve(__dirname,'..'),artifactDir=process.env.MASTERY_UI_ARTIFACT_DIR||'/workspace/artifacts/mastery-achievers-ui';
const liveOrigin=process.env.APP_ORIGIN,appOrigin=liveOrigin||'https://mastery-achievers.example/';
if(liveOrigin)assert(['http:','https:'].includes(new URL(liveOrigin).protocol));
const mime={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.mp3':'audio/mpeg','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'};
const id=index=>'00000000-0000-4000-8000-'+index.toString(16).padStart(12,'0');
const person=(index,name)=>({memberId:id(index),name,achievedAt:'2026-11-08T23:00:00.000Z'});
const totals={target1900:1900,target1000:1000,kobun400:400};
const identity={member:{id:id(1),name:'テスト中'},correctCount:200,totalPoints:10000,balance:10000,totalIncome:10000,spent:0,walletRevision:1};
const snapshot=(book,names=[])=>({book,reviewNumbers:[],sections:Array.from({length:totals[book]/100},(_,i)=>({section:i+1,from:i*100+1,to:(i+1)*100,total:100,mastered:i?0:99,percent:i?0:99,reviewCount:0,achievers:i?[]:names}))});
const deferred=()=>{let release,arrived;return{wait:new Promise(resolve=>release=resolve),ready:new Promise(resolve=>arrived=resolve),release:()=>release(),arrived:()=>arrived()};};
let checks=0;
const eq=(actual,expected,label)=>{checks++;assert.deepEqual(actual,expected,label);};
async function verify(engine){
 const browser=await(engine==='chromium'?chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']}):webkit.launch({executablePath:'/workspace/scratch/webkit-runtime/pw-run.sh',headless:true}));
 try{
  const page=await browser.newPage({viewport:{width:320,height:780},reducedMotion:'reduce'}),errors=[],requests=[];
  const data={target1900:snapshot('target1900',[person(1,'達成した人'),person(2,'<img src=x>'),person(3,'同じ名前'),person(4,'同じ名前'),person(5,'🚀'.repeat(20))]),target1000:snapshot('target1000',[person(6,'熟語の達成者')]),kobun400:snapshot('kobun400',[person(7,'古文の達成者')])};
  let signedIn=true,held;
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>localStorage.setItem('target-sound-enabled','false'));
  await page.route('**/*',async route=>{
   const u=new URL(route.request().url());requests.push(u.pathname);
   if(u.pathname.startsWith('/api/')){
    let body;
    if(u.pathname==='/api/session'||u.pathname==='/api/login')body=signedIn?identity:{member:null,correctCount:0,totalPoints:0,balance:0,totalIncome:0,spent:0};
    else if(u.pathname==='/api/logout'){signedIn=false;body={ok:true};}
    else if(u.pathname==='/api/ranking')body={ranking:[]};
    else if(u.pathname==='/api/mastery'){
     const book=u.searchParams.get('book');body=structuredClone(data[book]);
     if(held&&held.book===book){const current=held;held=undefined;current.arrived();await current.wait;}
    }else throw Error('Unexpected API '+u.pathname);
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
   }
   // Public deployment verification fetches actual assets, while every API
   // request above stays local, including login/logout/session requests.
   if(liveOrigin)return route.continue();
   const file=path.resolve(root,u.pathname.startsWith('/data/')?'.'+u.pathname:'public'+(u.pathname==='/'?'/index.html':u.pathname));
   if(!file.startsWith(root+path.sep))return route.abort();
   try{return await route.fulfill({status:200,contentType:mime[path.extname(file)]||'application/octet-stream',body:await fs.readFile(file)});}catch{return route.fulfill({status:404,body:'missing fixture'});}
  });
  async function rendered(count){await page.waitForFunction(n=>document.querySelectorAll('#masteryList>.mastery-row').length===n,count);checks++;}
  async function refresh(count){await page.locator('#masteryRefresh').click();await rendered(count);}
  async function home(){await page.locator('#masteryView [data-home]').click();await page.locator('#homeView').waitFor({state:'visible'});await page.waitForFunction(()=>document.getElementById('homeReviewStatus').textContent==='');}
  async function open(count){await page.locator('#masteryOpen').click();await rendered(count);}
  await page.goto(appOrigin);await page.waitForFunction(()=>document.getElementById('accountBadge').textContent==='テスト中');
  await open(19);
  const first=page.locator('#masteryList>.mastery-row').first();
  eq(await first.locator('.mastery-percent').textContent(),'99%','Current percentage does not gate past achievement names');
  eq(await first.locator('.mastery-achiever').allTextContents(),data.target1900.sections[0].achievers.map(p=>p.name));
  eq(await page.locator('#masteryList img').count(),0,'Names render as inert text');
  eq(await page.locator('.mastery-achiever-list').first().getAttribute('aria-label'),'Section 1の100%達成者');
  eq(await page.locator('#masteryList>.mastery-row').nth(1).locator('.mastery-achievers-empty').textContent(),'まだいません');
  eq(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Twenty-character names wrap at320px');
  eq(requests.includes('/x'),false,'A markup-like username triggers no resource loads');
  await fs.mkdir(artifactDir,{recursive:true});await page.screenshot({path:path.join(artifactDir,engine+'-achievers.png'),fullPage:false});

  data.target1900.sections[0].mastered=0;data.target1900.sections[0].percent=0;data.target1900.sections[0].achievers[0].name='変更したユーザー名';
  await refresh(19);eq(await first.locator('.mastery-percent').textContent(),'0%');eq(await first.locator('.mastery-achiever').first().textContent(),'変更したユーザー名','A later name update appears without deleting achievement');
  await home();await page.locator('#bookSelect').selectOption('kobun400');await open(4);
  eq(await page.locator('#masteryBook').textContent(),'古文単語');eq(await page.locator('.mastery-achiever').allTextContents(),['古文の達成者'],'Achievements stay within their book');
  for(const row of data.kobun400.sections)delete row.achievers;
  await refresh(4);eq(await page.locator('.mastery-achievers').count(),0,'Legacy omitted fields do not falsely claim no achievers');eq(await page.locator('#masteryError').isVisible(),false);

  const invalid=[null,[person(1,'A'),person(1,'B')],[{...person(1,'A'),memberId:'forged'}],[person(1,'🚀'.repeat(21))],[{...person(1,'A'),achievedAt:'not-a-date'}],Array.from({length:501},(_,i)=>person(i,'A'))];
  for(const value of invalid){
   data.kobun400.sections[0].achievers=value;await page.locator('#masteryRefresh').click();await page.locator('#masteryError').waitFor({state:'visible'});
   eq(await page.locator('#masteryList>.mastery-row').count(),0,'Malformed achiever data never partly renders');
  }
  data.kobun400=snapshot('kobun400',[person(7,'古文の達成者')]);await refresh(4);

  const stale=deferred();held={...stale,book:'kobun400'};await page.locator('#masteryRefresh').click();await stale.ready;
  await home();await page.locator('#bookSelect').selectOption('target1000');await open(10);stale.release();await page.waitForTimeout(80);
  eq(await page.locator('#masteryBook').textContent(),'英熟語Target 1000');eq(await page.locator('.mastery-achiever').allTextContents(),['熟語の達成者'],'An old book response cannot replace the selected book');
  const logoutStale=deferred();held={...logoutStale,book:'target1000'};await page.locator('#masteryRefresh').click();await logoutStale.ready;
  await page.locator('#settingsOpen').click();await page.locator('#logoutButton').click();await page.locator('#loginForm').waitFor({state:'visible'});await page.locator('#settingsClose').click();logoutStale.release();await page.waitForTimeout(80);
  eq(await page.locator('.mastery-achiever').count(),0,'Logging out clears old names and delayed results');eq(await page.locator('#masteryLogin').isVisible(),true);
  eq(errors,[],'No browser runtime errors');
  return{engine,passed:true,checks,publicAssets:!!liveOrigin};
 }finally{await browser.close();}
}
(async()=>{const results=[];for(const engine of['chromium','webkit'])results.push(await verify(engine));console.log(JSON.stringify({passed:true,checks,results,hostedAuthenticatedRequests:0,hostedAPIRequests:0}));})().catch(error=>{console.error(error);process.exitCode=1;});
