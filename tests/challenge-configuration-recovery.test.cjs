'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const http=require('node:http');
const {getConfig}=require('../server/config.cjs');
const {handler}=require('../server/router.cjs');
const identity=require('../server/identity.cjs');
const store=require('../server/store.cjs');
const random=()=>crypto.randomBytes(32).toString('base64url');
const PROJECT_SETTINGS=['TARGET_RPC_SECRET','TARGET_COOKIE_SECRET','KGS_TARGET_INTEGRATION_SECRET',
 'TARGET_SUPABASE_URL','TARGET_SUPABASE_PUBLISHABLE_KEY','KGS_IDENTITY_URL','TARGET_ALLOWED_ORIGINS'];
function configure(values){for(const [key,value] of Object.entries(values))if(value===undefined)delete process.env[key];else process.env[key]=value;}
function unconfiguredPreview(){
 process.env.VERCEL_ENV='preview';
 for(const key of PROJECT_SETTINGS)delete process.env[key];
}
async function productionEnvironment(fn){
 const values={NODE_ENV:'production',VERCEL:'1',VERCEL_ENV:'production',TARGET_DATABASE_URL:undefined,
  TARGET_RPC_SECRET:random(),TARGET_COOKIE_SECRET:random(),KGS_TARGET_INTEGRATION_SECRET:random(),
  TARGET_SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',TARGET_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_'+random(),
  KGS_IDENTITY_URL:'https://class.example.invalid',TARGET_ALLOWED_ORIGINS:'https://target.example.invalid'};
 const previous=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));
 configure(values);
 try{return await fn(values);}finally{
  for(const [key,value] of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;
 }
}
function request(port,body){
 return new Promise((resolve,reject)=>{
  const req=http.request({host:'127.0.0.1',port,path:'/api/challenge/answer',method:'POST',headers:{
   Host:'target.example.invalid',Origin:'https://target.example.invalid','Content-Type':'application/json',
   Cookie:'__Host-target_session='+random()
  }},res=>{
   let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);
   res.on('end',()=>{try{resolve({status:res.statusCode,headers:res.headers,body:JSON.parse(text)});}catch(error){reject(error);}});
  });req.on('error',reject);req.end(JSON.stringify(body));
 });
}

test('A Preview deployment missing Production-only project settings fails closed instead of reusing prior configuration',()=>productionEnvironment(async values=>{
 assert.equal(getConfig().supabaseOrigin,'https://abcdefghijklmnopqrst.supabase.co');
 unconfiguredPreview();
 assert.throws(()=>getConfig(),{status:503,code:'CONFIGURATION_REQUIRED'});
 configure(values);
 assert.equal(getConfig().supabaseOrigin,'https://abcdefghijklmnopqrst.supabase.co');
 // An explicitly configured Preview uses the same validation; its environment
 // name alone neither provides credentials nor makes them unnecessary.
 process.env.VERCEL_ENV='preview';
 assert.equal(getConfig().rpcSecret,values.TARGET_RPC_SECRET);
}));

test('A configuration outage stops a Lv.3 answer before identity/storage and the original UUID remains safely retryable',()=>productionEnvironment(async values=>{
 const originalMember=identity.requireMember,originalRpc=store.challengeRpc;
 const member={id:crypto.randomUUID(),name:'Configuration Fixture'};
 const body={requestId:crypto.randomUUID(),runId:crypto.randomUUID(),questionId:crypto.randomUUID(),choiceId:crypto.randomUUID()};
 const receipts=new Map();let identityCalls=0,rpcCalls=0,accepted=0;
 const snapshot={ok:true,run:{id:body.runId,level:3,status:'playing',question:{id:crypto.randomUUID(),book:'target1900',number:1,prompt:'fixture',choices:[]}},
  answer:{correct:true,damage:5,healedHp:0,enemyHealedHp:0,streakBonus:false},wallet:{totalIncome:123000,spent:1000,balance:122000,walletRevision:10}};
 identity.requireMember=async()=>{identityCalls++;return member;};
 store.challengeRpc=async(action,input)=>{
  rpcCalls++;assert.equal(action,'answer');assert.equal(input.memberId,member.id);assert.equal(input.requestId,body.requestId);
  const prior=receipts.get(input.requestId);
  if(prior){assert.equal(prior.questionId,input.questionId);assert.equal(prior.choiceId,input.choiceId);return {...snapshot,replayed:true};}
  accepted++;receipts.set(input.requestId,input);return snapshot;
 };
 const server=http.createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const port=server.address().port;
  unconfiguredPreview();
  let result=await request(port,body);
  assert.equal(result.status,503);assert.deepEqual(result.body,{error:{code:'CONFIGURATION_REQUIRED',message:'共有サーバーの設定が未完了です。'}});
  assert.equal(identityCalls,0);assert.equal(rpcCalls,0);assert.equal(accepted,0);
  assert.match(result.headers['cache-control'],/no-store/);
  configure(values);
  result=await request(port,body);assert.equal(result.status,200);assert.deepEqual(result.body,snapshot);
  assert.equal(identityCalls,1);assert.equal(rpcCalls,1);assert.equal(accepted,1);
  // A later failure must not cause a replacement answer UUID or a second award.
  unconfiguredPreview();
  result=await request(port,body);assert.equal(result.status,503);assert.equal(rpcCalls,1);assert.equal(accepted,1);
  configure(values);
  result=await request(port,body);assert.equal(result.status,200);assert.equal(result.body.replayed,true);
  assert.deepEqual(result.body.wallet,snapshot.wallet);assert.equal(accepted,1);assert.equal(identityCalls,2);
 }finally{
  identity.requireMember=originalMember;store.challengeRpc=originalRpc;
  await new Promise(resolve=>server.close(resolve));
 }
}));
