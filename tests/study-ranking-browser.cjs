'use strict';
// Actual public app; every API response is a local synthetic fixture.
// No hosted accounts, financial writes, camera or external services are used.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {chromium,webkit}=require('playwright');
const root=path.resolve(__dirname,'..'),artifacts='/workspace/artifacts/study-only-ranking';
const origin='https://study-ranking.example';
const member={id:'00000000-0000-4000-8000-000000000001',name:'暗記の本人'};
const signed=(total=9999990,revision=1)=>({member,correctCount:2000,totalPoints:total,totalIncome:total,balance:total-200000,spent:200000,walletRevision:revision});
const guest={member:null,correctCount:0,totalPoints:0,totalIncome:0,balance:0,spent:0};
const rows=Array.from({length:12},(_,i)=>({rank:i+1,name:i===0?'暗記で一位':i===1?'暗記の本人':'学習者'+(i+1),correctCount:2200-i,totalPoints:i===0?20000000:i===1?15000000:(12-i)*1000}));
const mime={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.mp3':'audio/mpeg','.webmanifest':'application/manifest+json'};
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
let checks=0;
const eq=(actual,expected,message)=>{assert.deepEqual(actual,expected,message);checks++;};
const ok=(value,message)=>{assert.ok(value,message);checks++;};
const gate=()=>{let arrive,release;return{ready:new Promise(r=>arrive=r),wait:new Promise(r=>release=r),arrive:()=>arrive(),release:()=>release()};};

async function environment(browser,{isGuest=false}={}){
 const context=await browser.newContext({viewport:{width:320,height:780},reducedMotion:'reduce'}),page=await context.newPage();
 const state={identity:isGuest?guest:signed(),ranking:rows,rankPlans:[],sessionPlans:[],errors:[],requests:[],external:[]};
 page.on('pageerror',error=>state.errors.push(error.message));
 await page.addInitScript(()=>localStorage.setItem('target-sound-enabled','false'));
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  state.requests.push({path:url.pathname,method:request.method()});
  if(url.origin!==origin){state.external.push(request.url());return route.abort();}
  if(url.pathname.startsWith('/api/')){
   let body,status=200;
   if(url.pathname==='/api/session'){
    const plan=state.sessionPlans.shift();body=plan?.body??state.identity;status=plan?.status??200;
    if(plan?.gate){plan.gate.arrive();await plan.gate.wait;}
   }else if(url.pathname==='/api/ranking'){
    const plan=state.rankPlans.shift();body=plan?.body??{ranking:state.ranking};status=plan?.status??200;
    if(plan?.gate){plan.gate.arrive();await plan.gate.wait;}
   }else if(url.pathname==='/api/login'){state.identity=signed();body=state.identity;}
   else if(url.pathname==='/api/logout'){state.identity=guest;body={ok:true};}
   else throw Error('Unexpected synthetic API '+url.pathname);
   return route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  }
  const file=path.resolve(root,url.pathname.startsWith('/data/')?'.'+url.pathname:'public'+(url.pathname==='/'?'/index.html':url.pathname));
  if(!file.startsWith(root+path.sep))return route.abort();
  try{return route.fulfill({status:200,contentType:mime[path.extname(file)]||'application/octet-stream',body:await fs.readFile(file)});}
  catch{return route.fulfill({status:404,body:'missing local fixture'});}
 });
 await page.goto(origin);
 await page.waitForFunction(expected=>document.getElementById('accountBadge').textContent===expected,isGuest?'ゲスト':member.name);
 await page.waitForFunction(()=>document.querySelectorAll('#homeRankingList>li').length===10);
 return{context,page,state};
}
async function layout(page){ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'ranking and metric fit320px');}
async function scores(page,target){return page.locator('#'+target+' .ranking-score').allTextContents();}
async function scoreWallet(page,value){await page.waitForFunction(expected=>document.getElementById('settingsScore').textContent===expected,value.toLocaleString('ja-JP')+'轟');checks++;}
async function openSettings(page){await page.locator('#settingsOpen').click();}
async function closeSettings(page){await page.locator('#settingsClose').click();}
async function clean(state){eq(state.errors,[],'no uncaught browser errors');eq(state.external,[],'all requests stay local');}

async function verify(engine){
 const browser=engine==='chromium'?await chromium.launch({headless:true,executablePath:'/usr/bin/chromium',args:['--no-sandbox']}):await webkit.launch({headless:true,executablePath:'/workspace/scratch/webkit-runtime/pw-run.sh'});
 const results=[];
 try{
  {
   const at=checks,{context,page,state}=await environment(browser);
   try{
    eq(await page.locator('#homeScore').textContent(),'暗記獲得','home ranking no longer exposes global total');
    eq(await scores(page,'homeRankingList'),rows.slice(0,10).map(row=>row.totalPoints.toLocaleString('ja-JP')+'轟'),'Top10 renders study scores supplied by the ranking API');
    eq(await page.locator('#homeRankingList').getAttribute('aria-label'),'暗記で獲得した轟ランキング 上位10人');
    await layout(page);await page.screenshot({path:path.join(artifacts,engine+'-home.png'),fullPage:true});
    await page.locator('#rankingOpen').click();await page.waitForFunction(()=>document.querySelectorAll('#rankingList>li').length===12);
    eq(await page.locator('#rankingTitle').textContent(),'暗記ランキング');
    eq(await page.title(),'暗記ランキング | 暗記');
    eq(await scores(page,'rankingList'),rows.map(row=>row.totalPoints.toLocaleString('ja-JP')+'轟'),'full ranking keeps every supplied study score');
    eq(await page.locator('#rankingList .ranking-score').nth(1).textContent(),'15,000,000轟','study income may exceed the same member’s adjusted global income; do not clamp it');
    eq(await page.locator('#rankingList').getAttribute('aria-label'),'暗記で獲得した轟ランキング');
    ok(!(await page.locator('#rankingList').textContent()).includes('9,999,990'),'global total is not substituted for study earnings');
    await layout(page);
    await openSettings(page);await scoreWallet(page,9999990);
    eq(await page.locator('#settingsBalance').textContent(),'9,799,990轟','Settings still shows authoritative spendable global balance');
    eq(await page.locator('.settings-wallet dt').allTextContents(),['保有金額','総所得']);
    eq(await page.locator('#homeScore').textContent(),'暗記獲得');
    await page.screenshot({path:path.join(artifacts,engine+'-settings.png'),fullPage:true});
    // A delayed older global wallet snapshot cannot replace the newer one.
    await closeSettings(page);const old=gate();
    state.sessionPlans.push({body:signed(25000000,2),gate:old},{body:signed(11000000,3)});
    await openSettings(page);await old.ready;await closeSettings(page);await openSettings(page);await scoreWallet(page,11000000);
    old.release();await page.waitForTimeout(60);await scoreWallet(page,11000000);
    eq(await page.locator('#settingsBalance').textContent(),'10,800,000轟');
    eq(await page.locator('#homeScore').textContent(),'暗記獲得','global refresh never overwrites the study metric label');
    await clean(state);
   }finally{await context.close();}
   results.push({engine,case:'study-ranking-and-independent-wallet',checks:checks-at,passed:true});
  }
  {
   const at=checks,{context,page,state}=await environment(browser,{isGuest:true});
   try{
    eq(await page.locator('#homeScore').textContent(),'暗記獲得','guest sees the same ranking basis');
    eq(await scores(page,'homeRankingList'),rows.slice(0,10).map(row=>row.totalPoints.toLocaleString('ja-JP')+'轟'));
    await openSettings(page);eq(await page.locator('#loginForm').isVisible(),true);eq(await page.locator('#loggedInSettings').isVisible(),false);
    await page.locator('#attendanceNumber').fill('1');await page.locator('#accountPin').fill('0123');await page.locator('#loginButton').click();await scoreWallet(page,9999990);
    eq(await page.locator('#accountPin').inputValue(),'','local login fixture clears PIN');
    eq(await page.locator('#homeScore').textContent(),'暗記獲得');
    await page.locator('#logoutButton').click();await page.locator('#loginForm').waitFor({state:'visible'});
    eq(await page.locator('#settingsScore').textContent(),'—','logout clears private global income');
    eq(await page.locator('#homeScore').textContent(),'暗記獲得');
    await clean(state);
   }finally{await context.close();}
   results.push({engine,case:'guest-login-logout-scope',checks:checks-at,passed:true});
  }
  {
   const at=checks,{context,page,state}=await environment(browser);
   try{
    const old=gate(),oldRows=[{rank:1,name:'遅い古い順位',correctCount:1,totalPoints:100}],newRows=[{rank:1,name:'新しい暗記順位',correctCount:3,totalPoints:300}];
    state.rankPlans.push({body:{ranking:oldRows},gate:old});
    await page.locator('#rankingOpen').click();await old.ready;
    await page.locator('#rankingView [data-home]').click();await page.waitForFunction(()=>document.querySelectorAll('#homeRankingList>li').length===10);
    state.rankPlans.push({body:{ranking:newRows}});
    await page.locator('#rankingOpen').click();await page.waitForFunction(()=>document.querySelector('#rankingList .ranking-name')?.textContent==='新しい暗記順位');
    old.release();await page.waitForTimeout(60);
    eq(await page.locator('#rankingList .ranking-name').allTextContents(),['新しい暗記順位'],'an older ranking request cannot overwrite a newer response');
    eq(await scores(page,'rankingList'),['300轟']);
    state.rankPlans.push({status:503,body:{error:{code:'STORAGE_UNAVAILABLE',message:'仮の接続失敗'}}});
    await page.locator('#rankingRefresh').click();await page.locator('#rankingError').waitFor({state:'visible'});
    eq(await page.locator('#rankingRefresh').isEnabled(),true,'failed refresh is retryable');
    eq(await page.locator('#rankingList .ranking-row').count(),0,'a failed read never substitutes the wallet total');
    state.rankPlans.push({body:{ranking:newRows}});
    await page.locator('#rankingRefresh').click();await page.waitForFunction(()=>document.querySelector('#rankingList .ranking-score')?.textContent==='300轟');
    eq(await page.locator('#rankingError').isVisible(),false);
    await clean(state);
   }finally{await context.close();}
   results.push({engine,case:'ranking-refresh-and-stale-response',checks:checks-at,passed:true});
  }
 }finally{await browser.close();}
 return results;
}

(async()=>{
 await fs.mkdir(artifacts,{recursive:true});const results=[];
 for(const engine of['chromium','webkit'])results.push(...await verify(engine));
 const sourceHashes={};for(const file of['public/app.js','public/index.html'])sourceHashes[file]=sha(await fs.readFile(path.join(root,file)));
 const report={passed:true,checkedAt:new Date().toISOString(),checks,results,sourceHashes,hostedRequests:0,authenticatedHostedRequests:0,acceptedHostedMutations:0};
 await fs.writeFile(path.join(artifacts,'browser-report.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({passed:true,checks,cases:results.length,report:path.join(artifacts,'browser-report.json')}));
})().catch(async error=>{await fs.mkdir(artifacts,{recursive:true});await fs.writeFile(path.join(artifacts,'browser-error.json'),JSON.stringify({passed:false,checks,error:error.stack||String(error)},null,2)+'\n');console.error(error.stack);process.exitCode=1;});
