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
test('internal Vercel route parameter is accepted; unexpected query is denied',async()=>{
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
   '/api/index?route=integrations%2Fkgs%2Fmastery-badges&debug=1',
   '/api/index?route=integrations%2Fkgs%2Fmastery-badges&route=integrations%2Fkgs%2Fmastery-badges',
   '/api/integrations/kgs/mastery-badges?debug=1'
  ]){
   const r=await request(url);assert.equal(r.status,400,url);
   assert.equal(r.data.error.code,'INVALID_REQUEST');
  }
 }finally{shop.authorize=originalAuthorize;badges.perform=originalPerform;}
});
