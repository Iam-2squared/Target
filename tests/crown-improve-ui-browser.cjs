'use strict';
// Actual static app/data, local synthetic account/mastery/quiz API only.
// Never sends credentials or accepted writes to a hosted application.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {chromium,webkit}=require('playwright');
const root=path.resolve(__dirname,'..');
const artifacts=process.env.CROWN_UI_ARTIFACTS||'/workspace/artifacts/crown-improve';
const origin='https://crown-improve.example/';
const units={
 crown:[{section:6,from:1,to:17},{section:7,from:18,to:32}],
 improve:[{section:8,from:1,to:10},{section:9,from:11,to:20},{section:10,from:21,to:30},{section:11,from:31,to:42}],
 cnn:[{section:1,from:1,to:24}],
 target1900:Array.from({length:19},(_,i)=>({section:i+1,from:i*100+1,to:(i+1)*100})),
 target1000:Array.from({length:10},(_,i)=>({section:i+1,from:i*100+1,to:(i+1)*100})),
 kobun400:Array.from({length:4},(_,i)=>({section:i+1,from:i*100+1,to:(i+1)*100}))
};
const title={crown:'Crown',improve:'Improve',cnn:'CNN',target1900:'Target 1900',target1000:'英熟語Target 1000',kobun400:'古文単語'};
const label=book=>book==='crown'?'Lesson':'Section';
const id=n=>'00000000-0000-4000-8000-'+n.toString(16).padStart(12,'0');
const member={member:{id:id(1),name:'教材の確認'},correctCount:100,totalPoints:10000,totalIncome:10000,balance:10000,spent:0,walletRevision:1};
const guest={member:null,correctCount:0,totalPoints:0,totalIncome:0,balance:0,spent:0};
const mime={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.mp3':'audio/mpeg','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'};
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
let checks=0;
const eq=(a,b,message)=>{assert.deepEqual(a,b,message);checks++;};
const ok=(value,message)=>{assert.ok(value,message);checks++;};
const deferred=()=>{let arrive,release;return{ready:new Promise(r=>arrive=r),wait:new Promise(r=>release=r),arrive:()=>arrive(),release:()=>release()};};
const normalize=x=>x.normalize('NFKC').replace(/\s+/gu,' ').trim().toLowerCase();

async function verify(engine,data){
 const launch=engine==='chromium'?()=>chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']}):()=>webkit.launch({executablePath:'/workspace/scratch/webkit-runtime/pw-run.sh',headless:true});
 const browser=await launch(),at=checks;
 try{
  const context=await browser.newContext({viewport:{width:320,height:780},reducedMotion:'reduce'});
  const page=await context.newPage(),errors=[],requests=[],starts=[];
  let signed=true,sequence=40,invalidBook=null,held=null,nextFailure=false;
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>localStorage.setItem('target-sound-enabled','false'));
  const reviewNumbers=book=>[1,units[book].at(-1).to];
  const mastery=book=>({book,reviewNumbers:reviewNumbers(book),sections:units[book].map((unit,i)=>{
   const total=unit.to-unit.from+1,reviewCount=reviewNumbers(book).filter(n=>n>=unit.from&&n<=unit.to).length,mastered=i===0?total-reviewCount:0;
   return{...unit,total,mastered,percent:Math.floor(mastered*100/total),reviewCount,
    achievers:i===0?[{memberId:id(2),name:title[book]+'の達成者',achievedAt:'2026-11-18T00:00:00.000Z'}]:[]};
  })});
  const question=(input,number)=>{
   const row=data[input.book][number-1],field=input.direction==='english'?'english':'japanese';
   const choices=[{id:id(++sequence),text:row[field]}],texts=new Set([normalize(row[field])]);
   for(const other of data[input.book]){
    const key=normalize(other[field]);
    if(normalize(other.english)===normalize(row.english)||normalize(other.japanese)===normalize(row.japanese)||texts.has(key))continue;
    choices.push({id:id(++sequence),text:other[field]});texts.add(key);if(choices.length===4)break;
   }
   return{id:id(++sequence),number,prompt:row[input.direction==='english'?'japanese':'english'],choices};
  };
  await page.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());requests.push({path:url.pathname,method:request.method()});
   if(url.origin!==new URL(origin).origin)throw new Error('Unexpected external request '+url.origin);
   if(url.pathname.startsWith('/api/')){
    let body,status=200;
    if(url.pathname==='/api/session'||url.pathname==='/api/login')body=signed?member:guest;
    else if(url.pathname==='/api/logout'){signed=false;body={ok:true};}
    else if(url.pathname==='/api/ranking')body={ranking:[]};
    else if(url.pathname==='/api/mastery'){
     const book=url.searchParams.get('book');body=mastery(book);
     if(invalidBook===book)body.sections[0]={...body.sections[0],from:body.sections[0].from+1};
     if(held?.book===book){const pending=held;held=null;pending.arrive();await pending.wait;}
    }else if(url.pathname==='/api/quiz/start'||url.pathname==='/api/quiz/review/start'){
     const input=request.postDataJSON();starts.push({path:url.pathname,input});
     if(nextFailure){nextFailure=false;status=503;body={error:{code:'STORAGE_UNAVAILABLE',message:'仮の通信失敗'}};}
     else{
      const selected=url.pathname.includes('/review/')?reviewNumbers(input.book).filter(n=>n>=input.from&&n<=input.to):Array.from({length:input.to-input.from+1},(_,i)=>input.from+i);
      if(!selected.length){status=409;body={error:{code:'REVIEW_EMPTY',message:'解き直し対象なし'}};}
      else body={quizId:id(++sequence),total:Math.min(input.count,selected.length),answeredCount:0,correctCount:0,quizPoints:0,question:question(input,selected[0]),bonus:null};
     }
    }else throw new Error('Unexpected synthetic API '+url.pathname);
    return route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
   }
   const file=path.resolve(root,url.pathname.startsWith('/data/')?'.'+url.pathname:'public'+(url.pathname==='/'?'/index.html':url.pathname));
   if(!file.startsWith(root+path.sep))return route.abort();
   try{return route.fulfill({status:200,contentType:mime[path.extname(file)]||'application/octet-stream',body:await fs.readFile(file)});}catch{return route.fulfill({status:404,body:'missing local fixture'});}
  });
  async function home(view){await page.locator('#'+view+'View [data-home]').click();await page.locator('#homeView').waitFor({state:'visible'});}
  async function select(book){await page.locator('#bookSelect').selectOption(book);eq(await page.locator('#bookSelect').inputValue(),book);}
  async function quit(){await page.locator('#quizQuit').click();await page.locator('#quitConfirm').click();await page.locator('#homeView').waitFor({state:'visible'});}
  async function openSetup(review=false){await page.locator(review?'#reviewOpen':'#testOpen').click();await page.locator('#setupView').waitFor({state:'visible'});}
  async function range(from,to){await page.locator('#rangeFrom').selectOption(String(from));await page.locator('#rangeTo').selectOption(String(to));}
  async function options(selector,book){eq(await page.locator(selector+' option').evaluateAll(nodes=>nodes.map(n=>({value:n.value,text:n.textContent}))),units[book].map(u=>({value:String(u.section),text:label(book)+' '+u.section})));}
  async function settledMemory(){await page.evaluate(async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});}
  async function start(){await page.locator('#testStart').click();await page.locator('#quizView').waitFor({state:'visible'});}
  function lastStart(){return starts.at(-1);}
  async function signedPayload(book,unit,review=false){
   const record=lastStart();eq(record.path,review?'/api/quiz/review/start':'/api/quiz/start');
   eq({...record.input,requestId:undefined},{book,direction:'english',count:100,from:unit.from,to:unit.to,requestId:undefined});
   ok(/^[0-9a-f-]{36}$/i.test(record.input.requestId));
   const selectedReview=reviewNumbers(book).filter(n=>n>=unit.from&&n<=unit.to);
   eq(await page.locator('#questionNumber').textContent(),'No. '+(review?selectedReview[0]:unit.from));
   eq(await page.locator('#questionPosition').textContent(),'1 / '+(review?selectedReview.length:unit.to-unit.from+1)+'問');
  }
  await page.goto(origin);await page.waitForFunction(()=>document.getElementById('accountBadge').textContent==='教材の確認');
  eq(await page.locator('#bookSelect option').evaluateAll(nodes=>nodes.map(n=>n.value)),['target1900','target1000','kobun400','crown','improve','cnn']);
  for(const book of['crown','improve','cnn']){
   await select(book);
   for(const unit of units[book]){
    await page.locator('#memorizeOpen').click();await page.locator('#memorySetupView').waitFor({state:'visible'});
    eq(await page.locator('#memorySetupBook').textContent(),title[book]);await options('#memoryRangeFrom',book);await options('#memoryRangeTo',book);
    await page.locator('#memoryRangeFrom').selectOption(String(unit.section));await page.locator('#memoryRangeTo').selectOption(String(unit.section));
    await page.locator('#memoryStart').click();await page.waitForFunction(()=>document.querySelectorAll('#memorySheet>.memory-row .memory-english').length>0);await settledMemory();
    const pages=await page.locator('#memoryPage option').count(),seen=[];
    for(let p=0;p<pages;p++){
     await page.locator('#memoryPage').selectOption({value:String(p)});await settledMemory();
     const rows=await page.locator('#memorySheet>.memory-row').evaluateAll(nodes=>nodes.map(node=>({number:Number(node.querySelector('.word-number').textContent),english:node.querySelector('.memory-english').textContent,japanese:node.querySelector('.memory-meaning').textContent})));
     seen.push(...rows);ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Memory fits320px');
    }
    eq(seen,data[book].slice(unit.from-1,unit.to).map(({number,english,japanese})=>({number,english,japanese})),'Every unit card and POS gloss appears once in source order');
    eq(await page.locator('#memorySheet').evaluate(el=>el.classList.contains('is-stacked')),false);
    await page.locator('#meaningsToggle').click();eq(await page.locator('#memorySheet').evaluate(el=>el.classList.contains('meanings-hidden')),true);await page.locator('#meaningsToggle').click();
    await home('memorize');
   }
   // Signed normal quizzes and review use the selected custom word boundaries.
   const unit=units[book].at(-1);await openSetup();await options('#rangeFrom',book);await range(unit.section,unit.section);
   await page.locator('#questionCount').selectOption('100');await page.locator('input[name=direction][value=english]').check();await start();await signedPayload(book,unit);await quit();
   await openSetup(true);eq(await page.locator('#rangeFrom').inputValue(),String(units[book][0].section));eq(await page.locator('#rangeTo').inputValue(),String(unit.section));
   await range(unit.section,unit.section);await start();await signedPayload(book,unit,true);await quit();
   await page.locator('#masteryOpen').click();await page.waitForFunction(n=>document.querySelectorAll('#masteryList>.mastery-row').length===n,units[book].length);
   eq(await page.locator('#masteryList .mastery-section').allTextContents(),units[book].map(u=>label(book)+' '+u.section));
   eq(await page.locator('#masteryList .mastery-count').allTextContents(),units[book].map((u,i)=>`${i?0:u.to-u.from+1-reviewNumbers(book).filter(n=>n>=u.from&&n<=u.to).length} / ${u.to-u.from+1}`));
   eq(await page.locator('#masteryList progress').evaluateAll(nodes=>nodes.map(n=>n.max)),units[book].map(u=>u.to-u.from+1));
   eq(await page.locator('.mastery-achiever').allTextContents(),[title[book]+'の達成者']);
   ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Custom mastery fits320px');
   invalidBook=book;await page.locator('#masteryRefresh').click();await page.locator('#masteryError').waitFor({state:'visible'});eq(await page.locator('#masteryList>.mastery-row').count(),0,'Malformed custom range does not partly render');
   invalidBook=null;await page.locator('#masteryRefresh').click();await page.waitForFunction(n=>document.querySelectorAll('#masteryList>.mastery-row').length===n,units[book].length);
   await page.screenshot({path:path.join(artifacts,engine+'-'+book+'-mastery.png'),fullPage:false});await home('mastery');
  }
  // Retry receipt identity remains tied to the same new-book selection.
  await select('crown');await openSetup();await range(6,7);await page.locator('#questionCount').selectOption('100');
  nextFailure=true;await page.locator('#testStart').click();await page.locator('#setupError').waitFor({state:'visible'});const retry=structuredClone(lastStart().input);
  await start();eq(lastStart().input,retry,'A transport retry reuses the request ID and exact range');await quit();
  // An older custom-book response cannot replace a newer custom-book view.
  await page.locator('#masteryOpen').click();await page.waitForFunction(()=>document.querySelectorAll('#masteryList>.mastery-row').length===2);
  const gate=deferred();held={...gate,book:'crown'};await page.locator('#masteryRefresh').click();await gate.ready;
  await home('mastery');await select('improve');await page.locator('#masteryOpen').click();await page.waitForFunction(()=>document.querySelectorAll('#masteryList>.mastery-row').length===4);gate.release();
  await page.waitForTimeout(60);eq(await page.locator('#masteryBook').textContent(),'Improve');eq(await page.locator('.mastery-achiever').allTextContents(),['Improveの達成者']);await home('mastery');
  // Revisit an original book, then return to a new one; no 100-card state leaks.
  await select('kobun400');await openSetup();await options('#rangeFrom','kobun400');await home('setup');
  await select('crown');await openSetup();await options('#rangeFrom','crown');eq(await page.locator('#rangeFrom').inputValue(),'6');eq(await page.locator('#rangeTo').inputValue(),'7');await home('setup');
  await page.locator('#settingsOpen').click();await page.locator('#logoutButton').click();await page.locator('#loginForm').waitFor({state:'visible'});await page.locator('#settingsClose').click();
  for(const book of['crown','improve','cnn']){
   await select(book);await openSetup(true);eq(await page.locator('#testStart').isDisabled(),true);eq(await page.locator('#reviewLogin').isVisible(),true);await home('setup');
   for(const unit of units[book])for(const direction of['english','japanese']){
    await openSetup();await range(unit.section,unit.section);await page.locator('#questionCount').selectOption('100');await page.locator('input[name=direction][value='+direction+']').check();const before=starts.length;
    await start();eq(starts.length,before,'Guest material practice does not call the signed start API');
    const number=Number((await page.locator('#questionNumber').textContent()).replace(/\D/g,'')),source=data[book][number-1];
    ok(number>=unit.from&&number<=unit.to);eq(await page.locator('#questionPosition').textContent(),'1 / '+(unit.to-unit.from+1)+'問');
    eq(await page.locator('#questionPrompt').textContent(),source[direction==='english'?'japanese':'english']);
    const texts=await page.locator('#questionChoices .choice-text').allTextContents();eq(texts.length,4);eq(new Set(texts.map(normalize)).size,4);ok(texts.includes(source[direction]),'The correct source translation is a choice');
    await quit();
   }
  }
  eq(errors,[],'No browser runtime errors');eq(requests.filter(r=>r.path==='/api/quiz/answer').length,0,'No synthetic quiz answers submitted');
  return{engine,passed:true,checks:checks-at,starts:starts.length,hostedRequests:0,syntheticAPIs:true};
 }finally{await browser.close();}
}

(async()=>{
 await fs.mkdir(artifacts,{recursive:true});const data={};for(const book of Object.keys(units))data[book]=JSON.parse(await fs.readFile(path.join(root,'data',book+'.json'),'utf8'));
 const results=[];for(const engine of['chromium','webkit'])results.push(await verify(engine,data));
 const hashes={};for(const file of['public/app.js','public/index.html','public/materials.js','data/crown.json','data/improve.json','data/cnn.json'])hashes[file]=sha(await fs.readFile(path.join(root,file)));
 const report={passed:true,checkedAt:new Date().toISOString(),checks,results,sourceHashes:hashes,hostedRequests:0,acceptedHostedMutations:0};
 await fs.writeFile(path.join(artifacts,'browser-report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
})().catch(async error=>{await fs.mkdir(artifacts,{recursive:true});await fs.writeFile(path.join(artifacts,'browser-error.json'),JSON.stringify({passed:false,error:error.stack,checks},null,2)+'\n');console.error(error);process.exitCode=1;});
