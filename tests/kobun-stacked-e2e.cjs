'use strict';
// Typography/pagination check against the actual public app and source datasets.
// Only the read-only guest session and empty ranking are fixtures; no DB or
// external account is accessed, and no quiz answer is simulated.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const http=require('node:http');
const path=require('node:path');
const {chromium,webkit}=require('playwright');
const root=path.resolve(__dirname,'..'),reportDir=path.join(root,'test-results');
const books=Object.fromEntries(['target1900','target1000','kobun400'].map(book=>[book,require('../data/'+book+'.json')]));
const engines=(process.env.STACKED_BROWSER||'chromium').split(',');
assert(engines.every(engine=>['chromium','webkit'].includes(engine)),'Use STACKED_BROWSER=chromium,webkit.');
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.mp3':'audio/mpeg','.webmanifest':'application/manifest+json'};
let checks=0;const results=[],pageErrors=[],unexpectedRequests=[];
const ok=(value,message)=>{checks++;assert(value,message);};
const eq=(actual,expected,message)=>{checks++;assert.deepEqual(actual,expected,message);};
async function settle(page){await page.evaluate(async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});}
async function home(page){await page.locator('#memorizeView [data-home]').click();await page.locator('#homeView').waitFor();}
async function open(page,book,section=1){
  await page.locator('#bookSelect').selectOption(book);
  await page.locator('#homeSectionFrom').selectOption(String(section));
  await page.locator('#homeSectionTo').selectOption(String(section));
  await page.locator('#memorizeOpen').click();
  await page.locator('#memorySheet .memory-row').first().waitFor();await settle(page);
  await page.locator('#memoryPage').selectOption({value:'0'});await settle(page);
}
async function snapshot(page){return page.evaluate(()=>{
  const bounds=node=>{const r=node.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
  const sheet=document.getElementById('memorySheet');
  const rows=Array.from(sheet.querySelectorAll(':scope > .memory-row'),row=>{
    const term=row.querySelector('.memory-english'),meaning=row.querySelector('.memory-meaning');
    const textRects=node=>{const range=document.createRange();range.selectNodeContents(node);return Array.from(range.getClientRects(),r=>({x:r.x,y:r.y,right:r.right,bottom:r.bottom}));};
    return{number:Number(row.querySelector('.word-number').textContent),term:term.textContent,meaning:meaning.textContent,
      bounds:bounds(row),wordBox:bounds(row.querySelector('.memory-word')),termBox:bounds(term),meaningBox:bounds(meaning),
      termMode:getComputedStyle(term).writingMode,meaningMode:getComputedStyle(meaning).writingMode,
      termText:textRects(term),meaningText:textRects(meaning),meaningVisibility:getComputedStyle(meaning).visibility};
  });
  return{rows,sheet:bounds(sheet),width:innerWidth,height:innerHeight,
    scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,
    page:Number(document.getElementById('memoryPage').value),pages:document.getElementById('memoryPage').options.length};
});}
function checkPage(s,book,label){
  ok(s.rows.length>0,label+' has visible entries');
  ok(s.scrollWidth<=s.width+1,label+' has no horizontal page scrolling');
  ok(s.scrollHeight<=s.height+1,label+' has no vertical page scrolling');
  let previousBottom=-Infinity;
  for(const row of s.rows){
    const source=books[book][row.number-1];ok(source,label+' has a valid source number');
    eq(row.term,source.english,label+' retains source term '+row.number);
    eq(row.meaning,source.japanese,label+' retains source meaning '+row.number);
    eq(row.termMode,'horizontal-tb',label+' term is horizontal');
    eq(row.meaningMode,'horizontal-tb',label+' meaning is horizontal');
    ok(row.bounds.y>=previousBottom-1,label+' entries run top-to-bottom without overlapping');previousBottom=row.bounds.bottom;
    if(book==='kobun400'){
      ok(row.wordBox.bottom<=row.meaningBox.y+1,label+' meaning is below the classical term');
      ok(Math.abs(row.wordBox.x-row.meaningBox.x)<=1&&Math.abs(row.wordBox.width-row.meaningBox.width)<=1,label+' classical term and meaning share the full-width card');
    }else ok(row.termBox.right<=row.meaningBox.x+1,label+' English term stays beside its meaning');
    for(const [kind,box,rects]of[['term',row.termBox,row.termText],['meaning',row.meaningBox,row.meaningText]]){
      ok(box.x>=s.sheet.x-2&&box.y>=s.sheet.y-2&&box.right<=s.sheet.right+2&&box.bottom<=s.sheet.bottom+2,label+' '+kind+' box stays within sheet for '+row.number);
      ok(box.x>=row.bounds.x-2&&box.y>=row.bounds.y-2&&box.right<=row.bounds.right+2&&box.bottom<=row.bounds.bottom+2,label+' '+kind+' box stays within its own entry without overlapping its neighbor for '+row.number);
      for(const rect of rects){
        ok(rect.x>=s.sheet.x-2&&rect.y>=s.sheet.y-2&&rect.right<=s.sheet.right+2&&rect.bottom<=s.sheet.bottom+2,label+' '+kind+' text stays within sheet for '+row.number);
        ok(rect.x>=box.x-2&&rect.y>=box.y-2&&rect.right<=box.right+2&&rect.bottom<=box.bottom+2,label+' '+kind+' text is not clipped for '+row.number);
      }
    }
  }
}
async function scenario(name,fn){const began=Date.now();try{await fn();results.push({name,status:'passed',durationMs:Date.now()-began});console.log('PASS '+name);}catch(error){results.push({name,status:'failed',message:error.message});throw error;}}
const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://localhost');
    if(url.pathname.startsWith('/api/')){
      res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
      if(req.method==='GET'&&url.pathname==='/api/session')return res.end(JSON.stringify({member:null,correctCount:0,totalPoints:0,balance:0,totalIncome:0,spent:0,bonus:null}));
      if(req.method==='GET'&&url.pathname==='/api/ranking')return res.end(JSON.stringify({ranking:[]}));
      unexpectedRequests.push(req.method+' '+url.pathname);res.statusCode=500;return res.end(JSON.stringify({error:{message:'Unexpected fixture API request.'}}));
    }
    const filename=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname.slice(1));
    const directory=filename.startsWith('data/')?root:path.join(root,'public'),file=path.resolve(directory,filename);
    if(!file.startsWith(directory+path.sep)){res.statusCode=403;return res.end();}
    const content=await fs.readFile(file);res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');res.end(content);
  }catch{res.statusCode=404;res.end('Not found');}
});
(async()=>{
  let browser,failure;
  try{
    await fs.mkdir(reportDir,{recursive:true});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base='http://127.0.0.1:'+server.address().port;
    for(const engine of engines){
      browser=engine==='webkit'?await webkit.launch({headless:true,executablePath:process.env.IOS_WEBKIT_EXECUTABLE||'/workspace/scratch/webkit-runtime/pw-run.sh'}):await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
      const context=await browser.newContext({viewport:{width:390,height:664}}),page=await context.newPage();
      page.on('pageerror',error=>pageErrors.push(engine+': '+error.message));
      await page.addInitScript(()=>localStorage.setItem('target-sound-enabled','false'));
      await page.goto(base,{waitUntil:'networkidle'});await page.waitForFunction(()=>document.getElementById('accountBadge').textContent==='ゲスト');
      for(const viewport of [{width:320,height:568},{width:390,height:664},{width:768,height:1024},{width:667,height:375}]){
        await scenario(engine+' '+viewport.width+'×'+viewport.height+' all400 classical entries fit in source order',async()=>{
          await page.setViewportSize(viewport);
          for(let section=1;section<=4;section++){
            await open(page,'kobun400',section);const first=await snapshot(page),numbers=[];
            ok(first.pages>1,'Each100-word Section has multiple pages');
            let previous;
            for(let index=0;index<first.pages;index++){
              await page.locator('#memoryPage').selectOption({value:String(index)});await settle(page);
              const state=await snapshot(page);eq(state.pages,first.pages,'Page count remains stable');eq(state.page,index,'Page jump retains requested page');
              checkPage(state,'kobun400',engine+' '+viewport.width+'×'+viewport.height+' Section'+section+' page'+index);
              if(previous){const used=previous.rows.reduce((height,row)=>height+Math.ceil(row.bounds.height),0),next=Math.ceil(state.rows[0].bounds.height);ok(used+next>previous.sheet.height-5,'The preceding page could not fit the next complete stacked card: '+JSON.stringify({viewport,section,page:index,used,nextNumber:state.rows[0].number,next,capacity:previous.sheet.height-5}));}
              numbers.push(...state.rows.map(row=>row.number));
              previous=state;
            }
            eq(numbers,Array.from({length:100},(_,index)=>(section-1)*100+index+1),'Every Section entry appears once without gaps');
            if(section===1){await page.locator('#memoryPage').selectOption({value:'0'});await settle(page);await page.screenshot({path:path.join(reportDir,'kobun-stacked-'+engine+'-'+viewport.width+'x'+viewport.height+'.png')});}
            await home(page);
          }
        });
      }
      await scenario(engine+' hiding meanings, page controls and resize retain the reading position',async()=>{
        await page.setViewportSize({width:390,height:664});await open(page,'kobun400');
        const before=await snapshot(page);await page.locator('#meaningsToggle').click();await settle(page);const hidden=await snapshot(page);
        eq(hidden.rows.map(row=>row.number),before.rows.map(row=>row.number),'Hiding meanings retains the visible words');eq(hidden.pages,before.pages,'Hiding meanings retains total pages');ok(hidden.rows.every(row=>row.meaningVisibility==='hidden'),'All meanings are hidden');
        await page.locator('#meaningsToggle').click();await settle(page);ok((await snapshot(page)).rows.every(row=>row.meaningVisibility==='visible'),'All meanings can be shown again');
        await page.locator('#memorySheet').click();await settle(page);eq((await snapshot(page)).page,1,'One tap on sheet moves to the next page');
        await page.locator('#memoryPrevious').click();await settle(page);eq((await snapshot(page)).page,0,'Previous returns to the first page');
        await page.locator('#memoryNext').click();await settle(page);eq((await snapshot(page)).page,1,'Next moves to the next page');
        await page.locator('#memoryPage').selectOption({value:'3'});await settle(page);const anchor=(await snapshot(page)).rows[0].number;
        await page.setViewportSize({width:768,height:1024});await settle(page);const resized=await snapshot(page);ok(resized.rows.some(row=>row.number===anchor),'The same source word stays visible after resize');checkPage(resized,'kobun400','resized tablet');
        await home(page);
      });
      await scenario(engine+' both English books keep horizontal layout and selected ranges',async()=>{
        await page.setViewportSize({width:390,height:664});
        for(const [book,section]of[['target1900',19],['target1000',10]]){
          await open(page,book,section);const first=await snapshot(page);checkPage(first,book,book+' first');eq(first.rows[0].number,(section-1)*100+1,'English selectedSection starts at the correct source word');
          await page.locator('#memoryPage').selectOption({value:String(first.pages-1)});await settle(page);const last=await snapshot(page);checkPage(last,book,book+' last');eq(last.rows.at(-1).number,section*100,'English selectedSection ends at the correct source word');await home(page);
        }
      });
      await context.close();await browser.close();browser=null;
    }
    eq(pageErrors,[],'There are no unhandled browser errors');eq(unexpectedRequests,[],'The layout checks made no unexpected API requests');
  }catch(error){failure=error;console.error(error.stack);}
  finally{
    await browser?.close().catch(()=>{});await new Promise(resolve=>server.close(resolve));
    const report={generatedAt:new Date().toISOString(),engines,environment:'Actual public app/assets and datasets over loopback HTTP; only guest session and empty ranking are fixture responses; no DB',physicalIPhoneVerified:false,checks,pageErrors,unexpectedRequests,results};
    await fs.mkdir(reportDir,{recursive:true});await fs.writeFile(path.join(reportDir,'kobun-stacked-'+engines.join('-')+'-results.json'),JSON.stringify(report,null,2)+'\n');
    console.log(results.filter(result=>result.status==='passed').length+' scenarios passed; '+checks+' assertions.');if(failure)process.exitCode=1;
  }
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
