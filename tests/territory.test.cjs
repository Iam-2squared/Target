'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const p=require('../server/territory-protocol.cjs'),territory=require('../server/territory.cjs'),store=require('../server/store.cjs'),{handler}=require('../server/router.cjs');
const memberId=crypto.randomUUID(),identity={memberId,name:'信頼済みの表示名'},seasonId='2026-11-02',serverNow='2026-11-08T08:00:00.000Z';
function state(){const tiles=Array.from({length:2500},()=>[0,0,0]);for(const c of p.CASTLES)tiles[c.y*50+c.x]=[0,8,0];return{rulesVersion:1,width:50,height:50,maxPlayers:40,rules:{...p.RULES},season:{id:seasonId,startsAt:'2026-11-01T15:00:00.000Z',endsAt:'2026-11-08T15:00:00.000Z'},serverNow,summaryMinute:Math.floor(Date.parse(serverNow)/60000),revision:0,selfSlot:null,balance:0,totalIncome:0,spent:0,mapSpent:0,players:[],tiles,changes:[],events:[],notifications:[]};}
function response(){return{statusCode:0,headers:{},headersSent:false,writableEnded:false,setHeader(k,v){this.headers[k]=v;},end(bytes){this.writableEnded=true;this.value=JSON.parse(bytes.toString());}};}
async function isolated(fn){const env={NODE_ENV:'test',VERCEL:'',TARGET_RPC_SECRET:crypto.randomBytes(32).toString('hex'),TARGET_COOKIE_SECRET:crypto.randomBytes(32).toString('hex'),KGS_TARGET_INTEGRATION_SECRET:crypto.randomBytes(32).toString('hex'),KGS_IDENTITY_URL:'http://127.0.0.1:3381',TARGET_ALLOWED_ORIGINS:'http://127.0.0.1:3380',TARGET_DATABASE_URL:'postgresql://127.0.0.1/target_territory_unit_test'};const before=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]])),rpc=store.territoryRpc,mapRpc=store.mapRpc;Object.assign(process.env,env);try{await fn(env);}finally{for(const[k,v]of Object.entries(before)){if(v===undefined)delete process.env[k];else process.env[k]=v;}store.territoryRpc=rpc;store.mapRpc=mapRpc;}}
test('trusted territory service rejects authority extras and malformed commands before RPC',()=>{
 const quote={...identity,seasonId,rulesVersion:1,command:{type:'join'}};assert.deepEqual(p.parseInput('quote',quote,{trusted:true}),quote);
 for(const extra of[{role:'admin'},{score:1},{balance:1000000},{troops:1000},{memberId:'not-uuid'},{name:''},{rulesVersion:2},{command:{type:'join',slot:1}}])assert.throws(()=>p.parseInput('quote',{...quote,...extra},{trusted:true}));
 for(const v of[{...identity,revision:0},{...identity,seasonId},{...identity,summaryMinute:1}])assert.throws(()=>p.parseInput('state',v,{trusted:true}));
});
test('removed territory perform rejects all inputs before a private RPC',async()=>isolated(async()=>{
 let calls=0;store.territoryRpc=async()=>{calls++;return state();};
 for(const action of ['state','quote','act'])for(const value of [identity,null,{...identity,role:'admin'}])await assert.rejects(territory.perform(action,value),e=>e.status===410&&e.code==='MAP_REMOVED');
 assert.equal(calls,0);
}));
test('private territory routes preserve bearer auth then reject before body and storage access',async()=>isolated(async env=>{
 let reads=0,calls=0;store.territoryRpc=async()=>{calls++;return state();};
 for(const action of['state','quote','act']){
  for(const authorization of[undefined,'','Bearer invalid']){const req={url:'/api/integrations/kgs/territory/'+action,method:'POST',headers:{authorization,'content-type':'application/json'}};Object.defineProperty(req,'body',{get(){reads++;throw Error('must remain unread');}});const res=response();await handler(req,res);assert.equal(res.statusCode,404);assert.equal(reads,0);assert.equal(calls,0);}
  const req={url:'/api/index?route=integrations/kgs/territory/'+action,query:{route:'integrations/kgs/territory/'+action},method:'POST',headers:{authorization:'Bearer '+env.KGS_TARGET_INTEGRATION_SECRET,'content-type':'invalid'}};Object.defineProperty(req,'body',{get(){reads++;throw Error('must remain unread');}});const res=response();await handler(req,res);assert.equal(res.statusCode,410);assert.equal(res.value.error.code,'MAP_REMOVED');
 }
 assert.equal(reads,0);assert.equal(calls,0);
}));
