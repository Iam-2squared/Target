'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const calculus=require('../server/calculus.cjs'),store=require('../server/store.cjs'),identity=require('../server/identity.cjs'),{handler}=require('../server/router.cjs');
const random=()=>crypto.randomBytes(32).toString('base64url'),memberId=crypto.randomUUID();
const config={test:false,rpcSecret:random(),cookieSecret:random(),integrationSecret:random()};
const status=()=>({linked:true,conversionRate:10000,member:{id:memberId,name:'連携テスト'},balance:40000,totalIncome:140000,calculusIncome:90000,syncPending:false});
async function fixture(fn){
 const values={NODE_ENV:'production',VERCEL:'1',TARGET_DATABASE_URL:undefined,TARGET_RPC_SECRET:config.rpcSecret,TARGET_COOKIE_SECRET:config.cookieSecret,
  KGS_TARGET_INTEGRATION_SECRET:config.integrationSecret,CALCULUS_TARGET_INTEGRATION_SECRET:random(),CALCULUS_SOURCE_URL:'https://source.example.invalid',
  KGS_IDENTITY_URL:'https://class.example.invalid',TARGET_ALLOWED_ORIGINS:'https://target.example.invalid',TARGET_SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',TARGET_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_'+random()};
 const previous=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]])),original={fetch:global.fetch,rpc:store.calculusRpc,shop:store.shopRpc,identity:identity.callIdentity};
 for(const[key,value]of Object.entries(values))if(value===undefined)delete process.env[key];else process.env[key]=value;
 try{return await fn(values);}finally{global.fetch=original.fetch;store.calculusRpc=original.rpc;store.shopRpc=original.shop;identity.callIdentity=original.identity;
  for(const[key,value]of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;}
}
function response(){return {headers:{},setHeader(key,value){this.headers[key.toLowerCase()]=value;},getHeader(key){return this.headers[key.toLowerCase()];},end(bytes){this.result=JSON.parse(String(bytes));this.writableEnded=true;}};}
test('calculus service authenticates before reading a body, including an unconfigured bridge',()=>fixture(async values=>{
 for(const authorization of [undefined,'Bearer wrong','Bearer '+values.CALCULUS_TARGET_INTEGRATION_SECRET+'x']){
  let read=false;const req={method:'POST',url:'/api/integrations/calculus/link',headers:{authorization},get body(){read=true;throw Error('must not parse');}},res=response();
  await handler(req,res);assert.equal(res.statusCode,404);assert.equal(read,false);assert.equal(res.result.error.code,'NOT_FOUND');
 }
 delete process.env.CALCULUS_TARGET_INTEGRATION_SECRET;
 const res=response();await handler({method:'POST',url:'/api/integrations/calculus/status',headers:{},get body(){throw Error('must not parse');}},res);
 assert.equal(res.statusCode,404);assert.equal(calculus.settings(config,false),null);
}));
test('service inputs cannot assert source amounts, member identity or a relink',()=>{
 assert.deepEqual(calculus.parseService('sync',{userId:1}),{userId:1});
 const proofToken=random();assert.deepEqual(calculus.parseService('link',{userId:1,proofToken}),{userId:1,proofToken});
 for(const value of [{userId:0},{userId:'1'},{userId:2147483648},{userId:1,totalPoints:100},{userId:1,memberId},{userId:1,proofToken:'bad'},null]){
  assert.throws(()=>calculus.parseService('link',value),error=>error.status===400);
 }
 for(const source of [{totals:[]},{totals:[{userId:1,totalPoints:1,known:false,deleted:true}]},{totals:[{userId:1,totalPoints:1.5,known:true,deleted:false}]},
  {totals:[{userId:2,totalPoints:1,known:true,deleted:false}]}])assert.throws(()=>calculus.parseTotals(source,[1]),error=>error.status===503);
 assert.deepEqual(calculus.parseTotals({totals:[{userId:1,totalPoints:9,known:true,deleted:true}]},[1]),[{userId:1,totalPoints:9,known:true,deleted:true}]);
});
test('link fetches verified KGS identity and authoritative lifetime points before the storage mutation',()=>fixture(async values=>{
 const calls=[];identity.callIdentity=async(action,input)=>{calls.push('verify');assert.equal(action,'verify');assert.deepEqual(input,{token:values.CALCULUS_TARGET_INTEGRATION_SECRET});return{member:status().member};};
 global.fetch=async(url,options)=>{calls.push('source');assert.equal(url,'https://source.example.invalid/api/integrations/target/totals');assert.deepEqual(JSON.parse(options.body),{userIds:[1]});
  assert.equal(options.headers.Authorization,'Bearer '+values.CALCULUS_TARGET_INTEGRATION_SECRET);return Response.json({totals:[{userId:1,totalPoints:9,known:true,deleted:false}]});};
 store.calculusRpc=async(action,input)=>{calls.push('ledger');assert.equal(action,'link');assert.deepEqual(input,{userId:1,totalPoints:9,known:true,deleted:false,memberId,name:'連携テスト'});return status();};
 assert.deepEqual(await calculus.perform('link',{userId:1,proofToken:values.CALCULUS_TARGET_INTEGRATION_SECRET},config),status());
 assert.equal(calls.at(-1),'ledger');assert.equal(calls.length,3);
}));
test('outages preserve posted income and source response errors cannot advance the watermark',()=>fixture(async()=>{
 const calls=[];store.calculusRpc=async(action)=>{calls.push(action);return status();};
 global.fetch=async()=>{throw Error('offline');};
 assert.deepEqual(await calculus.perform('sync',{userId:1},config),{...status(),syncPending:true});assert.deepEqual(calls,['status']);
 store.calculusRpc=async(action)=>{calls.push(action);assert.equal(action,'links');return{links:[{userId:1,memberId}]};};
 global.fetch=async()=>Response.json({totals:[{userId:1,totalPoints:1000000001,known:true,deleted:false}]});
 assert.deepEqual(await calculus.refreshMembers([memberId],config),{syncPending:true});assert.equal(calls.includes('sync'),false);
}));
test('wealth refresh uses one bounded source batch and preserves every requested zero-income member',()=>fixture(async()=>{
 const ids=Array.from({length:100},()=>crypto.randomUUID());let fetched=0,stored=0;
 store.calculusRpc=async(action,input)=>{
  if(action==='links'){assert.deepEqual(input,{memberIds:ids});return{links:ids.map((id,index)=>({userId:index+1,memberId:id}))};}
  if(action==='sync'){stored++;assert.equal(input.totals.length,100);return{synced:100};}
  assert.equal(action,'wealth');assert.equal(stored,1);return{entries:ids.map(id=>({memberId:id,totalIncome:0}))};
 };
 global.fetch=async(url,options)=>{fetched++;const body=JSON.parse(options.body);assert.equal(body.userIds.length,100);assert.equal(new Set(body.userIds).size,100);
  return Response.json({totals:body.userIds.map(userId=>({userId,totalPoints:0,known:true,deleted:false}))});};
 const result=await calculus.wealth({memberId:ids[0],name:'表示名',members:ids.map(id=>({id,name:'表示名'}))},config);
 assert.equal(fetched,1);assert.equal(result.entries.length,100);assert.equal(result.syncPending,false);
}));
test('configured source URL rejects credentials, paths and HTTP outside explicit test loopback',()=>fixture(async()=>{
 for(const value of ['http://source.example.invalid','https://user:pass@source.example.invalid','https://source.example.invalid/path','https://source.example.invalid/?secret=value']){
  process.env.CALCULUS_SOURCE_URL=value;assert.throws(()=>calculus.settings(config),error=>error.status===503);
 }
 process.env.CALCULUS_SOURCE_URL='http://127.0.0.1:3400';assert.throws(()=>calculus.settings(config),error=>error.status===503);
 assert.equal(calculus.settings({...config,test:true}).origin,'http://127.0.0.1:3400');
}));
