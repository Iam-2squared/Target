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

function request(port,url,query){
 return new Promise((resolve,reject)=>{
  const req=http.get({host:'127.0.0.1',port,path:url,headers:query===undefined?{}:{'x-test-helper-query':JSON.stringify(query)}},res=>{
   let body='';res.setEncoding('utf8');res.on('data',chunk=>body+=chunk);
   res.on('end',()=>{try{resolve({status:res.statusCode,headers:res.headers,body:JSON.parse(body)});}catch(error){reject(error);}});
  });req.on('error',reject);
 });
}

test('Mastery HTTP route accepts both Vercel rewrite URL shapes and still requires authentication',()=>hostedEnvironment(async()=>{
 const server=http.createServer((req,res)=>{
  // Framework helper metadata is separate from the raw HTTP URL, as it is in
  // hosted Vercel Node functions. Fixtures contain only synthetic query data.
  const helper=req.headers['x-test-helper-query'];
  if(helper!==undefined)req.query=JSON.parse(helper);
  return handler(req,res);
 });
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
  for(const [url,query] of [
   ['/api/index?route=mastery',{route:'mastery',book:'target1900'}],
   ['/api/index',{route:'mastery',book:'target1000'}],
   ['/api/mastery',{route:'mastery',book:'target1900'}],
   ['/api/mastery?route=mastery',{route:'mastery',book:'target1000'}],
   ['/api/mastery?book=target1900',{route:'mastery',book:'target1900'}],
   ['/api/mastery?book=target1000&route=mastery',{route:'mastery',book:'target1000'}],
   ['/api/index?route=mastery&book=target1900',{route:['mastery'],book:['target1900']}]
  ]){
   const result=await request(port,url,query);
   assert.equal(result.status,401,url+' with helper');assert.equal(result.body.error.code,'AUTHENTICATION_REQUIRED');
   assert.match(result.headers['cache-control'],/no-store/);
   assert.equal(result.headers['x-target-mastery-shape'],undefined);
   assert(!Object.hasOwn(result.body,'sections'));assert(!Object.hasOwn(result.body,'reviewNumbers'));
  }
  for(const [url,query] of [
   ['/api/index?route=mastery',{route:'mastery',book:['target1900','target1900']}],
   ['/api/mastery?book=target1900',{route:'mastery',book:'target1000'}],
   ['/api/mastery?book=target1900',{route:'ranking',book:'target1900'}],
   ['/api/mastery?book=target1900',{route:['mastery','mastery'],book:'target1900'}],
   ['/api/index?route=mastery',{route:'mastery',book:'target1900',extra:'synthetic-user-name'}],
   ['/api/mastery',{route:'mastery',book:1900}],
   ['/api/mastery',{route:'mastery',book:{forged:'target1900'}}],
   ['/api/mastery',[]],
   ['/api/mastery','forged-helper'],
   ['/api/mastery?book=target1900&book=target1900',{book:'target1900'}],
   ['/api/index?route=mastery&route=mastery',{route:'mastery',book:'target1900'}]
  ]){
   const result=await request(port,url,query);
   assert.equal(result.status,400,url+' with invalid helper');assert.equal(result.body.error.code,'INVALID_BOOK');
   assert.match(result.headers['cache-control'],/no-store/);
   assert.match(result.headers['x-target-mastery-shape'],/^ub=\d+;uv=[01];ur=\d+;rv=[01];uo=\d+;qb=[sano];qv=[01];qr=[01];qo=\d+$/);
   assert(!Object.hasOwn(result.body,'sections'));assert(!Object.hasOwn(result.body,'reviewNumbers'));
   assert(!result.headers['x-target-mastery-shape'].includes('synthetic-user-name'));
   assert(!result.headers['x-target-mastery-shape'].includes('target1900'));
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
