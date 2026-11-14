'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Readable}=require('node:stream');
const {handler}=require('../server/router.cjs');
const shop=require('../server/shop.cjs'),badges=require('../server/badges.cjs');
const originalAuthorize=shop.authorize,originalPerform=badges.perform;
function response(){
 const headers={};return {statusCode:200,headersSent:false,writableEnded:false,
  setHeader(k,v){headers[k.toLowerCase()]=v;},getHeader(k){return headers[k.toLowerCase()]},
  end(body){this.body=body;this.writableEnded=true;},headers};
}
async function request(url){
 const req=Readable.from([Buffer.from('{}')]);
 req.method='POST';req.url=url;req.headers={'content-type':'application/json'};
 const res=response();await handler(req,res);
 return {status:res.statusCode,data:JSON.parse(res.body)};
}
test('Vercel rewrite parameters are ignored and never change authorized body',async()=>{
 const vars=['NODE_ENV','VERCEL','TARGET_RPC_SECRET','TARGET_COOKIE_SECRET','KGS_TARGET_INTEGRATION_SECRET','KGS_IDENTITY_URL','TARGET_ALLOWED_ORIGINS','TARGET_SUPABASE_URL','TARGET_SUPABASE_PUBLISHABLE_KEY'];
 const original=Object.fromEntries(vars.map(key=>[key,process.env[key]]));
 Object.assign(process.env,{
  NODE_ENV:'test',VERCEL:'',TARGET_RPC_SECRET:'r'.repeat(40),TARGET_COOKIE_SECRET:'c'.repeat(40),
  KGS_TARGET_INTEGRATION_SECRET:'k'.repeat(40),KGS_IDENTITY_URL:'http://127.0.0.1:3000',
  TARGET_ALLOWED_ORIGINS:'http://127.0.0.1:3000',
  TARGET_SUPABASE_URL:'https://fixture.supabase.co',TARGET_SUPABASE_PUBLISHABLE_KEY:'fixture-test-key'.repeat(4)
 });
 shop.authorize=()=>{};
 badges.perform=async()=>({ok:true,earnedIds:[],completedSections:0,sectionTotal:33});
 try{
  for(const url of [
   '/api/integrations/kgs/mastery-badges',
   '/api/index?route=integrations%2Fkgs%2Fmastery-badges'
  ]){
   const r=await request(url);assert.equal(r.status,200,url);assert.equal(r.data.ok,true);
  }
  for(const url of [
   '/api/index?route=integrations%2Fkgs%2Fmastery-badges&path=integrations%2Fkgs%2Fmastery-badges',
   '/api/index?route=integrations%2Fkgs%2Fmastery-badges&debug=1',
   '/api/integrations/kgs/mastery-badges?debug=1'
  ]){
   const r=await request(url);assert.equal(r.status,200,url);
   assert.equal(r.data.ok,true);
  }
 }finally{shop.authorize=originalAuthorize;badges.perform=originalPerform;for(const key of vars){if(original[key]===undefined)delete process.env[key];else process.env[key]=original[key];}}
});
