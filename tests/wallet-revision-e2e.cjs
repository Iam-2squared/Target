'use strict';
// Frontend protocol fixtures only; the game ledger is tested against local PG
// by the separate integration suite. No hosted accounts, credits or bets.
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs/promises'),path=require('node:path');
const {chromium,webkit}=require('playwright');
const root=path.resolve(__dirname,'..'),data=require('../data/target1900.json');
const engines=(process.env.WALLET_BROWSER||'chromium').split(',');
assert(engines.every(engine=>['chromium','webkit'].includes(engine)));
const A='00000000-0000-4000-8000-000000000001',B='00000000-0000-4000-8000-000000000002';
const identity=(totalPoints,walletRevision,id=A)=>({member:{id,name:'同じ表示名'},correctCount:100,totalPoints,totalIncome:totalPoints,balance:totalPoints,spent:0,walletRevision});
const guest=()=>({member:null,correctCount:0,totalPoints:0,totalIncome:0,balance:0,spent:0});
const question=index=>({id:'question-'+index,number:index+1,prompt:data[index].japanese,choices:Array.from({length:4},(_,i)=>({id:'choice-'+i,text:data[(index+i)%data.length].english}))});
const deferred=()=>{let release;const wait=new Promise(resolve=>{release=resolve;});return{wait,release};};
let state,sessionPlans=[],answerPlan,answerCount=0,recordedPosts=0,checks=0;
const json=(res,value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://fixture.invalid');
    if(url.pathname.startsWith('/api/')){
      let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):undefined;
      if(url.pathname==='/api/session'){const plan=sessionPlans.shift();if(plan){await plan.wait;return json(res,plan.value,plan.status);}return json(res,state);}
      if(url.pathname==='/api/login')return json(res,state);
      if(url.pathname==='/api/logout'){state=guest();return json(res,{ok:true});}
      if(url.pathname==='/api/ranking')return json(res,{ranking:[]});
      if(url.pathname==='/api/mastery')return json(res,{book:'target1900',reviewNumbers:[],sections:Array.from({length:19},(_,i)=>({section:i+1,from:i*100+1,to:i*100+100,total:100,mastered:0,percent:0,reviewCount:0}))});
      if(url.pathname==='/api/quiz/start'){recordedPosts++;answerCount=0;return json(res,{quizId:'fixture-quiz',total:10,answeredCount:0,correctCount:0,quizPoints:0,question:question(0)});}
      if(url.pathname==='/api/quiz/answer'){
        recordedPosts++;assert.equal(body.questionId,'question-'+answerCount);const current=answerCount++;
        const plan=answerPlan;answerPlan=undefined;if(plan)await plan.wait;
        return json(res,{correct:true,correctChoiceId:'choice-0',correctText:data[current].english,answeredCount:current+1,correctCount:current+1,
          awardPoints:100,quizPoints:(current+1)*100,totalPoints:plan?.total??state.totalPoints,walletRevision:plan?.revision??state.walletRevision,
          balance:plan?.total??state.balance,total:10,finished:false,nextQuestion:question(current+1)});
      }
      throw Error('Unexpected fixture API '+url.pathname);
    }
    const folder=url.pathname.startsWith('/data/')?root:path.join(root,'public');
    const relative=url.pathname==='/'?'/index.html':url.pathname;
    const file=path.join(folder,relative);if(!file.startsWith(folder+path.sep))throw Error('Invalid fixture path');
    const content=await fs.readFile(file),types={'.html':'text/html','.js':'text/javascript','.json':'application/json','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.mp3':'audio/mpeg'};
    res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream'});res.end(content);
  }catch(error){res.writeHead(500,{'Content-Type':'text/plain'});res.end('Fixture error');console.error(error.message);}
});
const eq=(value,expected,label)=>{checks++;assert.equal(value,expected,label);};
async function score(page,expected){await page.waitForFunction(value=>document.getElementById('homeScore').textContent===value,expected.toLocaleString('ja-JP')+'轟');checks++;}
async function settings(page){await page.evaluate(()=>document.getElementById('settingsOpen').click());}
async function closeSettings(page){await page.locator('#settingsClose').click();}
async function startQuiz(page){await page.locator('#testOpen').click();await page.locator('#testStart').click();await page.locator('#questionChoices button').first().waitFor();}
async function fresh(browser,base,snapshot){
  state=snapshot;sessionPlans=[];answerPlan=undefined;
  const context=await browser.newContext({viewport:{width:390,height:844}});
  await context.addInitScript(()=>localStorage.setItem('target-sound-enabled','false'));
  const page=await context.newPage();page.on('pageerror',error=>{throw error;});await page.goto(base);await page.waitForFunction(()=>document.getElementById('accountBadge').textContent!=='接続未確認');
  return{page,context};
}
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
  try{for(const engine of engines){
    const browser=engine==='webkit'?await webkit.launch({headless:true,executablePath:process.env.IOS_WEBKIT_EXECUTABLE||'/workspace/scratch/webkit-runtime/pw-run.sh'}):await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
    try{
      let{page,context}=await fresh(browser,base,identity(300000,10));await score(page,300000);
      await startQuiz(page);state=identity(0,11);await page.locator('#questionChoices button').first().click();
      await page.waitForFunction(()=>document.getElementById('quizMode').textContent==='ランキングに記録'&&document.getElementById('quizPoints').textContent==='100轟');
      await score(page,0);eq(await page.locator('#quizError').isVisible(),false,'recorded quiz accepts net total below current quiz earnings');
      await settings(page);await page.waitForFunction(()=>document.getElementById('settingsBalance').textContent==='0轟');
      for(const snapshot of[identity(50000,12),identity(1000,13),identity(900000,12),{...identity(900000,14),walletRevision:undefined}]){
        state=snapshot;await closeSettings(page);await settings(page);await page.waitForTimeout(100);
        await score(page,snapshot.walletRevision===12&&snapshot.totalPoints===50000?50000:1000);
      }
      await closeSettings(page);
      const first=deferred();sessionPlans.push({value:identity(500,15),wait:first.wait},{value:identity(2000,14),wait:Promise.resolve()});
      await settings(page);await page.waitForTimeout(100);await closeSettings(page);await settings(page);await score(page,2000);first.release();await score(page,500);
      await closeSettings(page);
      const older=deferred();sessionPlans.push({value:identity(80000,14),wait:older.wait},{value:identity(300,16),wait:Promise.resolve()});
      await settings(page);await page.waitForTimeout(100);await closeSettings(page);await settings(page);await score(page,300);older.release();await page.waitForTimeout(100);await score(page,300);
      await context.close();

      ({page,context}=await fresh(browser,base,identity(10000,20)));await startQuiz(page);
      const held=deferred();answerPlan={wait:held.wait,total:9000,revision:21};await page.locator('#questionChoices button').first().click();
      state=identity(1000,22);await settings(page);await score(page,1000);held.release();
      await page.waitForFunction(()=>document.getElementById('quizMode').textContent==='ランキングに記録');await score(page,1000);
      eq(await page.locator('#settingsBalance').textContent(),'1,000轟','older answer cannot overwrite a newer loss snapshot');await context.close();

      ({page,context}=await fresh(browser,base,identity(10000,20)));await startQuiz(page);
      const expiredAnswer=deferred();answerPlan={wait:expiredAnswer.wait,total:9000,revision:21};await page.locator('#questionChoices button').first().click();
      sessionPlans.push({wait:Promise.resolve(),status:401,value:{error:{code:'SESSION_EXPIRED',message:'ログインし直してください。'}}});
      await settings(page);await page.locator('#loginForm').waitFor({state:'visible'});expiredAnswer.release();await page.waitForTimeout(100);
      eq(await page.locator('#homeScore').textContent(),'','an answer delayed past session expiry cannot restore account income');
      eq(await page.locator('#rewardCelebration').isVisible(),false,'expired session cannot restore a delayed reward');await context.close();

      ({page,context}=await fresh(browser,base,identity(300000,100)));state=identity(100,1,B);await settings(page);await score(page,100);
      eq(await page.locator('#settingsBalance').textContent(),'100轟','same-name account switch resets per-account revision');
      await page.locator('#logoutButton').click();await page.locator('#loginForm').waitFor({state:'visible'});
      state=identity(1000,0,A);await page.locator('#attendanceNumber').fill('1');await page.locator('#accountPin').fill('0000');await page.locator('#loginButton').click();
      await score(page,1000);eq(await page.locator('#accountPin').inputValue(),'','PIN is cleared after login');await context.close();

      ({page,context}=await fresh(browser,base,guest()));const before=recordedPosts;await startQuiz(page);
      const number=Number((await page.locator('#questionNumber').textContent()).match(/No\. (\d+)/)[1]);
      await page.locator('#questionChoices button').filter({has:page.getByText(data[number-1].english,{exact:true})}).click();
      await page.waitForFunction(()=>!document.getElementById('quizAdvanceSurface').hidden);eq(recordedPosts,before,'guest quiz still submits no stored answers');await context.close();
      console.log('PASS '+engine+' wallet revision, lower net, stale responses, account scope and guest flow');
    }finally{await browser.close();}
  }}finally{await new Promise(resolve=>server.close(resolve));}
  console.log(checks+' wallet frontend assertions passed.');
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
