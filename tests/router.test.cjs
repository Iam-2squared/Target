'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const http=require('node:http');
const {handler}=require('../server/router.cjs');
const random=()=>crypto.randomBytes(32).toString('base64url');

async function hostedEnvironment(fn){
 const values={NODE_ENV:'production',VERCEL:'1',TARGET_DATABASE_URL:undefined,
  TARGET_RPC_SECRET:random(),TARGET_COOKIE_SECRET:random(),KGS_TARGET_INTEGRATION_SECRET:random(),
  TARGET_SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',TARGET_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_'+random(),
  KGS_IDENTITY_URL:'https://class.example.invalid',TARGET_ALLOWED_ORIGINS:'https://target.example.invalid'};
 const previous=Object.fromEntries(Object.keys(values).map(k=>[k,process.env[k]]));
 for(const[k,v]of Object.entries(values))if(v===undefined)delete process.env[k];else process.env[k]=v;
 try{return await fn();}finally{for(const[k,v]of Object.entries(previous))if(v===undefined)delete process.env[k];else process.env[k]=v;}
}

function request(port,url){
 return new Promise((resolve,reject)=>{
  const req=http.get({host:'127.0.0.1',port,path:url},res=>{
   let body='';res.setEncoding('utf8');res.on('data',chunk=>body+=chunk);
   res.on('end',()=>{try{resolve({status:res.statusCode,headers:res.headers,body:JSON.parse(body)});}catch(error){reject(error);}});
  });req.on('error',reject);
 });
}

test('Mastery HTTP route accepts both Vercel rewrite URL shapes and still requires authentication',()=>hostedEnvironment(async()=>{
 const server=http.createServer(handler);
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const port=server.address().port;
 try{
  for(const url of [
   '/api/mastery?book=target1900',
   '/api/mastery?book=target1000',
   '/api/mastery?book=target1900&route=mastery',
   '/api/mastery?route=mastery&book=target1000',
   '/api/index?route=mastery&book=target1900',
   '/api/index?book=target1000&route=mastery'
  ]){
   const result=await request(port,url);
   assert.equal(result.status,401,url);assert.equal(result.body.error.code,'AUTHENTICATION_REQUIRED',url);
   assert.match(result.headers['cache-control'],/no-store/,url);
   assert(!Object.hasOwn(result.body,'sections'),url);assert(!Object.hasOwn(result.body,'reviewNumbers'),url);
  }
  for(const url of [
   '/api/mastery',
   '/api/mastery?book=invalid',
   '/api/mastery?book=target1900&book=target1000',
   '/api/mastery?book=target1900&unexpected=value',
   '/api/mastery?book=target1900&route=ranking',
   '/api/mastery?book=target1900&route=',
   '/api/mastery?book=target1900&route=mastery&route=mastery',
   '/api/index?route=mastery&book=target1900&unexpected=value',
   '/api/index?route=mastery&book=target1900&book=target1000',
   '/api/index?route=mastery&book=target1900&route=ranking'
  ]){
   const result=await request(port,url);
   assert.equal(result.status,400,url);assert.equal(result.body.error.code,'INVALID_BOOK',url);
   assert.match(result.headers['cache-control'],/no-store/,url);
   assert(!Object.hasOwn(result.body,'sections'),url);assert(!Object.hasOwn(result.body,'reviewNumbers'),url);
  }
 }finally{await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
}));
