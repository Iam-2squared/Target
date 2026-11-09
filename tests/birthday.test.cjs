'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const birthday=require('../server/birthday.cjs'),store=require('../server/store.cjs'),shop=require('../server/shop.cjs'),{handler}=require('../server/router.cjs');
const random=()=>crypto.randomBytes(32).toString('base64url'),memberId=crypto.randomUUID(),gift={memberId,name:'誕生日',birthdayDate:'2026-01-01'};
async function fixture(fn){
 const values={NODE_ENV:'production',VERCEL:'1',TARGET_DATABASE_URL:undefined,TARGET_RPC_SECRET:random(),TARGET_COOKIE_SECRET:random(),KGS_TARGET_INTEGRATION_SECRET:random(),CRON_SECRET:random(),
  CALCULUS_TARGET_INTEGRATION_SECRET:undefined,KGS_IDENTITY_URL:'https://class.example.invalid',TARGET_ALLOWED_ORIGINS:'https://target.example.invalid',TARGET_SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',TARGET_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_'+random()};
 const previous=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]])),original={fetch:global.fetch,rpc:store.birthdayRpc,shop:store.shopRpc,now:Date.now};
 for(const[key,value]of Object.entries(values))if(value===undefined)delete process.env[key];else process.env[key]=value;
 try{return await fn(values);}finally{global.fetch=original.fetch;store.birthdayRpc=original.rpc;store.shopRpc=original.shop;Date.now=original.now;
  for(const[key,value]of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;}
}
function response(){return{headers:{},setHeader(key,value){this.headers[key.toLowerCase()]=value;},getHeader(key){return this.headers[key.toLowerCase()];},end(bytes){this.result=JSON.parse(String(bytes));this.writableEnded=true;}};}
test('birthday private routes and production cron reject credentials before body access',()=>fixture(async values=>{
 for(const path of ['/api/integrations/kgs/birthday-gift','/api/integrations/kgs/birthday-gift/seen','/api/birthday-gifts/cron']){
  let read=false;const req={method:path.endsWith('/cron')?'GET':'POST',url:path,headers:{authorization:'Bearer wrong'},get body(){read=true;throw Error('must not read');}},res=response();
  await handler(req,res);assert.equal(res.statusCode,404);assert.equal(read,false);
 }
 const res=response();await handler({method:'POST',url:'/api/birthday-gifts/cron',headers:{authorization:'Bearer '+values.CRON_SECRET},get body(){throw Error('must not read');}},res);assert.equal(res.statusCode,405);
 delete process.env.CRON_SECRET;assert.throws(()=>birthday.authorizeCron({headers:{}}),error=>error.status===404);
}));
test('birthday routes accept matching Vercel metadata but reject query authority, duplicates and conflicts',()=>{
 const path='/api/integrations/kgs/birthday-gift',expected=path.slice(5);
 for(const req of [{url:path},{url:'/api/index?route='+expected,query:{path:expected,route:expected}},{url:path,query:{path:[expected]}}])assert.equal(birthday.readQuery(req,path),undefined);
 for(const req of [{url:path+'?amount=100000'},{url:path+'?memberId='+memberId},{url:path+'?path='+expected+'&path='+expected},{url:path,query:{path:'profile'}},{url:path+'?route='+expected,query:{route:'other'}},{url:path,query:{route:[expected,expected]}}])assert.throws(()=>birthday.readQuery(req,path),error=>error.status===400);
 assert.deepEqual(birthday.parseInput('status',{memberId,name:'誕生日'}),{memberId});
 for(const input of [{memberId,name:'誕生日',amount:100000},{memberId,name:'誕生日',giftYear:2026},{memberId,name:''},{memberId:'wrong',name:'誕生日'}])assert.throws(()=>birthday.parseInput('status',input),error=>error.status===400);
});
test('birthday source DTO rejects malformed or duplicate annual grants before touching storage',()=>{
 assert.deepEqual(birthday.parseSource({gifts:[gift],hasMore:false}),{gifts:[gift],hasMore:false});
 for(const value of [{gifts:[{...gift,amount:100000}],hasMore:false},{gifts:[gift,{...gift,birthdayDate:'2026-02-01'}],hasMore:false},{gifts:[{...gift,birthdayDate:'2026-02-30'}],hasMore:false},{gifts:[],hasMore:true},{gifts:[gift],hasMore:'yes'}])assert.throws(()=>birthday.parseSource(value),error=>error.status===503);
 for(const value of [{gift:{giftYear:2026,birthdayDate:'2025-01-01',amount:100000,seen:false}},{gift:{giftYear:2026,birthdayDate:'2026-01-01',amount:1,seen:false}},{gift:null,extra:1}])assert.throws(()=>birthday.parseStatus(value),error=>error.status===503);
});
test('failed acknowledgement preserves credited money and repeated source delivery is harmless',()=>fixture(async values=>{
 let credit=0,ackCalls=0,grants=0;const calls=[];
 store.birthdayRpc=async(action,input)=>{calls.push('ledger');assert.equal(action,'grant');assert.deepEqual(input,{gifts:[gift]});grants++;const granted=credit?0:1;credit=100000;return{granted};};
 global.fetch=async(url,options)=>{
  assert.equal(options.headers.Authorization,'Bearer '+values.KGS_TARGET_INTEGRATION_SECRET);assert.equal(options.redirect,'error');
  if(url.endsWith('/ack')){calls.push('ack');ackCalls++;assert.deepEqual(JSON.parse(options.body),{gifts:[{memberId,birthdayDate:gift.birthdayDate}]});if(ackCalls===1)throw Error('lost acknowledgement');return Response.json({ok:true});}
  calls.push('source');assert.deepEqual(JSON.parse(options.body),{});return Response.json({gifts:[gift],hasMore:false});
 };
 const first=await birthday.refresh();assert.equal(first.granted,1);assert.equal(first.syncPending,true);assert.equal(credit,100000);
 const retry=await birthday.refresh();assert.equal(retry.granted,0);assert.equal(retry.syncPending,false);assert.equal(credit,100000);assert.equal(grants,2);assert.deepEqual(calls,['source','ledger','ack','source','ledger','ack']);
}));
test('foreground refresh coalesces concurrent requests; cron drains at most five batches and clears pending once empty',()=>fixture(async()=>{
 let fetches=0,batch=0,grantCalls=0;
 global.fetch=async url=>{if(url.endsWith('/ack'))return Response.json({ok:true});fetches++;await Promise.resolve();return Response.json({gifts:[],hasMore:false});};
 const concurrent=await Promise.all(Array.from({length:40},()=>birthday.refresh()));assert.equal(fetches,1);assert(concurrent.every(result=>!result.syncPending));
 global.fetch=async url=>{if(url.endsWith('/ack'))return Response.json({ok:true});batch++;return Response.json({gifts:[{...gift,memberId:crypto.randomUUID()}],hasMore:true});};
 store.birthdayRpc=async()=>{grantCalls++;return{granted:1};};
 const bounded=await birthday.refresh({drain:true});assert.equal(batch,5);assert.equal(grantCalls,5);assert.equal(bounded.syncPending,true);assert.equal(bounded.processed,5);
 batch=0;global.fetch=async url=>{if(url.endsWith('/ack'))return Response.json({ok:true});batch++;return Response.json({gifts:[{...gift,memberId:crypto.randomUUID()}],hasMore:batch===1});};
 const drained=await birthday.refresh({drain:true});assert.equal(batch,2);assert.equal(drained.granted,2);assert.equal(drained.syncPending,false);
}));
test('cron passes a shrinking overall deadline to storage and stops work after the budget',()=>fixture(async()=>{
 let now=1000,sourceCalls=0;Date.now=()=>now;
 global.fetch=async()=>{sourceCalls++;now+=21000;return Response.json({gifts:[gift],hasMore:true});};
 store.birthdayRpc=async(action,input,options)=>{assert(options.timeoutMs<=1000);now+=1001;return{granted:1};};
 const result=await birthday.refresh({drain:true});assert.equal(sourceCalls,1);assert.equal(result.granted,1);assert.equal(result.syncPending,true);
}));
test('source outage preserves ordinary wallets and returns cached receipt status without inventing gifts',()=>fixture(async()=>{
 global.fetch=async()=>{throw Error('offline');};
 const wallet={...shop.guestWallet(),balance:200000,totalIncome:200000};store.shopRpc=async()=>wallet;
 assert.deepEqual(await shop.perform('wallet',{memberId,name:'誕生日'}),wallet);
 store.birthdayRpc=async(action,input)=>{assert.equal(action,'status');assert.deepEqual(input,{memberId});return{gift:null};};
 assert.deepEqual(await birthday.perform('status',{memberId,name:'誕生日'}),{gift:null,syncPending:true});
}));
