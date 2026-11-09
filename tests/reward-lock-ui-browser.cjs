'use strict';
// Local browser fixtures only; never authenticates or posts to a hosted service.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium,webkit}=require('playwright');
const root=path.resolve(__dirname,'..'),data=require('../data/target1900.json');
const mime={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.mp3':'audio/mpeg','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'};
let checks=0;
async function verify(type){
 const browser=await type.launch(type===chromium?{executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']}:{executablePath:'/workspace/scratch/webkit-runtime/pw-run.sh',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:320,height:780},reducedMotion:'reduce'}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>localStorage.setItem('target-sound-enabled','false'));
  await page.route('**/*',async route=>{
   const u=new URL(route.request().url());
   if(u.pathname.startsWith('/api/')){
    const body=u.pathname==='/api/session'?{member:null,correctCount:0,totalPoints:0,balance:0,totalIncome:0,spent:0,bonus:null}:{entries:[]};
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
   }
   const file=path.resolve(root,u.pathname.startsWith('/data/')?'.'+u.pathname:'public'+(u.pathname==='/'?'/index.html':u.pathname));
   if(!file.startsWith(root+path.sep))return route.abort();
   try{return await route.fulfill({status:200,contentType:mime[path.extname(file)]||'application/octet-stream',body:await fs.readFile(file)});}catch{return route.fulfill({status:404,body:'missing fixture'});}
  });
  await page.goto('https://reward-lock.example/');await page.locator('#accountBadge').filter({hasText:'ゲスト'}).waitFor();
  async function start(){await page.locator('#testOpen').click();await page.locator('#testStart').click();await page.locator('#quizView').waitFor({state:'visible'});}
  async function answer(correct,{advance=true}={}){
   const position=await page.locator('#questionPosition').innerText(),number=Number((await page.locator('#questionNumber').innerText()).match(/\d+/)[0]);
   const choices=await page.locator('#questionChoices .choice-text').allTextContents(),at=choices.findIndex(text=>text===data[number-1].english);
   assert(at>=0);checks++;
   await page.locator('#questionChoices button').nth(correct?at:(at+1)%4).click();
   await page.locator('#answerFeedback').waitFor({state:'visible'});
   assert.equal(await page.locator('#feedbackTitle').innerText(),correct?'正解':'不正解');checks++;
   const status=await page.locator('#rewardLockStatus').innerText(),points=await page.locator('#quizPoints').innerText(),celebration=await page.locator('#rewardCelebration').isVisible();
   if(advance){await page.locator('#quizAdvanceSurface').click({force:true});await page.waitForFunction(old=>document.getElementById('questionPosition').textContent!==old,position);await page.waitForTimeout(310);}
   return{status,points,celebration};
  }
  await start();await answer(false);let result=await answer(false,{advance:false});assert.match(result.status,/加点停止中.*0\/3/);assert.equal(result.points,'0轟');checks+=2;
  await page.locator('#quizQuit').click();await page.locator('#quitConfirm').click();await page.locator('#homeView').waitFor({state:'visible'});await start();
  assert.match(await page.locator('#rewardLockStatus').innerText(),/加点停止中.*0\/3/);checks++;
  for(const [correct,progress]of [[true,1],[true,2],[false,0],[true,1],[true,2]]){
   result=await answer(correct);assert.match(result.status,new RegExp('加点停止中.*'+progress+'/3'));assert.equal(result.points,'0轟');assert.equal(result.celebration,false);checks+=3;
  }
  result=await answer(true);assert.match(result.status,/次の問題から加点/);assert.equal(result.points,'0轟');assert.equal(result.celebration,false);checks+=3;
  assert.equal(await page.locator('#rewardLockStatus').isVisible(),false);checks++;
  result=await answer(true,{advance:false});assert.notEqual(result.points,'0轟');assert.equal(result.celebration,true);checks+=2;
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);checks+=2;
  const output='/workspace/artifacts/anki-reward-lock';await fs.mkdir(output,{recursive:true});await page.screenshot({path:path.join(output,type===chromium?'chromium-reward-resumed.png':'webkit-reward-resumed.png')});
  return{engine:type===chromium?'chromium':'webkit',passed:true};
 }finally{await browser.close();}
}
(async()=>{const results=[];for(const type of [chromium,webkit])results.push(await verify(type));console.log(JSON.stringify({passed:true,checks,results,hostedRequests:0}));})().catch(error=>{console.error(error);process.exitCode=1;});
