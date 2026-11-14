'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const protocol=require('../server/map-protocol.cjs'),map=require('../server/map.cjs'),store=require('../server/store.cjs'),shop=require('../server/shop.cjs');
const {handler}=require('../server/router.cjs');
const memberId=crypto.randomUUID(),requestId=crypto.randomUUID(),shape={type:'line',x1:4,y1:8,x2:8,y2:8};
const wallet={balance:99500,totalIncome:100000,spent:500,mapSpent:500};
const state=()=>({...wallet,width:500,height:500,unitPrice:100,overwritePrice:1000,revision:1,pixels:Buffer.alloc(250000).toString('base64'),rows:[],palette:[...protocol.PALETTE]});
const input={memberId,name:'本当の表示名'};
function response(){return{statusCode:0,headers:{},headersSent:false,writableEnded:false,setHeader(key,value){this.headers[key]=value;},end(bytes){this.writableEnded=true;this.value=JSON.parse(bytes.toString('utf8'));}};}
async function isolated(fn){
 const env={NODE_ENV:'test',VERCEL:'',TARGET_RPC_SECRET:crypto.randomBytes(32).toString('hex'),TARGET_COOKIE_SECRET:crypto.randomBytes(32).toString('hex'),KGS_TARGET_INTEGRATION_SECRET:crypto.randomBytes(32).toString('hex'),KGS_IDENTITY_URL:'http://127.0.0.1:3381',TARGET_ALLOWED_ORIGINS:'http://127.0.0.1:3380',TARGET_DATABASE_URL:'postgresql://127.0.0.1/target_map_unit_test'};
 const prior=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]])),old=store.mapRpc;Object.assign(process.env,env);
 try{await fn(env);}finally{for(const[key,value]of Object.entries(prior)){if(value===undefined)delete process.env[key];else process.env[key]=value;}store.mapRpc=old;}
}
test('trusted map service accepts no client role, account override, invalid price or extra field',()=>{
 assert.deepEqual(protocol.parseInput('buy',{...input,requestId,shape,color:1,maxCost:500,expectedUnitPrice:100,expectedOverwritePrice:1000},{trusted:true}),{...input,shape,color:1,requestId,maxCost:500,expectedUnitPrice:100,expectedOverwritePrice:1000});
 for(const expectedOverwritePrice of [undefined,100,0,'1000'])assert.throws(()=>protocol.parseInput('buy',{...input,requestId,shape,color:1,maxCost:500,expectedUnitPrice:100,expectedOverwritePrice},{trusted:true}));
 for(const extra of [{role:'admin'},{balance:1},{ownerId:memberId},{name:''},{memberId:'../member'}])assert.throws(()=>protocol.parseInput('quote',{...input,shape,color:1,...extra},{trusted:true}));
});
test('removed map perform rejects every action before input processing or a private RPC',async()=>isolated(async()=>{
 let calls=0;store.mapRpc=async()=>{calls++;return state();};
 for(const action of ['state','quote','buy'])for(const value of [input,null,{...input,role:'admin'}])await assert.rejects(map.perform(action,value),e=>e.status===410&&e.code==='MAP_REMOVED');
 assert.equal(calls,0);
}));
test('private map routes authorize first then return410 without reading a body or storage',async()=>isolated(async env=>{
 let reads=0,calls=0;store.mapRpc=async()=>{calls++;return state();};
 for(const action of ['state','quote','buy']){
  for(const authorization of [undefined,'','Bearer invalid']){
   const req={url:'/api/integrations/kgs/map/'+action,method:'POST',headers:{authorization,'content-type':'application/json'}};Object.defineProperty(req,'body',{get(){reads++;throw Error('Body must remain unread');}});
   const res=response();await handler(req,res);assert.equal(res.statusCode,404);assert.equal(reads,0);assert.equal(calls,0);
  }
  const req={url:'/api/index?route=integrations/kgs/map/'+action,query:{route:'integrations/kgs/map/'+action},method:'POST',headers:{authorization:'Bearer '+env.KGS_TARGET_INTEGRATION_SECRET,'content-type':'invalid'}};Object.defineProperty(req,'body',{get(){reads++;throw Error('Body must remain unread');}});
  const res=response();await handler(req,res);assert.equal(res.statusCode,410);assert.equal(res.value.error.code,'MAP_REMOVED');
 }
 assert.equal(reads,0);assert.equal(calls,0);
}));
test('modern wallet keeps map expenses distinct from immutable gacha receipts',()=>{
 const value={...shop.guestWallet(),balance:9500,totalIncome:10000,spent:500,mapSpent:500};assert.deepEqual(shop.validateWallet(value),value);
 for(const patch of [{mapSpent:400},{mapSpent:501},{mapSpent:600},{mapSpent:-100},{mapSpent:null}])assert.throws(()=>shop.validateWallet({...value,...patch}),error=>error.status===503);
});
