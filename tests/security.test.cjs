'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {getConfig,checkOrigin}=require('../server/config.cjs');
const {setSession,clearSession,sessionToken,attemptIdentity}=require('../server/identity.cjs');
const random=()=>crypto.randomBytes(32).toString('base64url');
function environment(fn){
  const values={NODE_ENV:'production',VERCEL:'1',TARGET_DATABASE_URL:undefined,
    TARGET_RPC_SECRET:random(),TARGET_COOKIE_SECRET:random(),KGS_TARGET_INTEGRATION_SECRET:random(),
    TARGET_SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',TARGET_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_'+random(),
    KGS_IDENTITY_URL:'https://class.example.invalid',TARGET_ALLOWED_ORIGINS:'https://target.example.invalid'};
  const previous=Object.fromEntries(Object.keys(values).map(k=>[k,process.env[k]]));
  for(const [k,v]of Object.entries(values))if(v===undefined)delete process.env[k];else process.env[k]=v;
  try{return fn();}finally{for(const[k,v]of Object.entries(previous))if(v===undefined)delete process.env[k];else process.env[k]=v;}
}
function response(){const headers=new Map();return{getHeader:name=>headers.get(name),setHeader:(name,value)=>headers.set(name,value)};}

test('Hosted session and logout cookies enforce host-only Secure HttpOnly SameSite boundaries',()=>environment(()=>{
  const config=getConfig(),res=response();
  assert.equal(config.test,false);assert.equal(config.sessionCookie,'__Host-target_session');
  setSession(res,random(),new Date(Date.now()+300000).toISOString(),config);clearSession(res,config);
  for(const cookie of res.getHeader('Set-Cookie')){
    assert(cookie.startsWith('__Host-target_session='));assert(cookie.includes('; Path=/;'));
    assert(cookie.includes('; Secure'));assert(cookie.includes('; HttpOnly'));assert(cookie.includes('; SameSite=Strict'));
    assert(!/;\s*Domain=/i.test(cookie));
  }
  assert(res.getHeader('Set-Cookie').at(-1).includes('Max-Age=0'));
}));

test('Ambiguous duplicate cookies are refused and unsigned attempt identities are replaced',()=>environment(()=>{
  const config=getConfig(),token=random();
  assert.equal(sessionToken({headers:{cookie:`${config.sessionCookie}=${token}; ${config.sessionCookie}=${token}`}},config),null);
  const res=response();const result=attemptIdentity({headers:{cookie:`${config.attemptCookie}=${token}.forged`}},res,config);
  assert.notEqual(result,token);assert.equal(result.length,43);assert(res.getHeader('Set-Cookie')[0].includes('; Secure'));
}));

test('Origin checks require the allowed HTTPS origin and matching request host',()=>environment(()=>{
  const config=getConfig();
  checkOrigin({headers:{origin:'https://target.example.invalid',host:'target.example.invalid'}},config);
  for(const headers of [
    {origin:'https://other.example.invalid',host:'target.example.invalid'},
    {origin:'https://target.example.invalid',host:'other.example.invalid'},
    {origin:'https://target.example.invalid',host:'target.example.invalid','sec-fetch-site':'cross-site'},
    {host:'target.example.invalid'}
  ])assert.throws(()=>checkOrigin({headers},config),error=>error.status===403);
}));

test('Hosted configuration rejects missing secrets and local database connections',()=>environment(()=>{
  for(const key of ['TARGET_RPC_SECRET','TARGET_COOKIE_SECRET','KGS_TARGET_INTEGRATION_SECRET']){
    const prior=process.env[key];delete process.env[key];
    assert.throws(()=>getConfig(),error=>error.status===503&&error.code==='CONFIGURATION_REQUIRED');process.env[key]=prior;
  }
  process.env.TARGET_DATABASE_URL='postgres://localhost/target_example_test';
  assert.throws(()=>getConfig(),error=>error.status===503);
}));

test('Expired or unbounded identity sessions cannot create a persistent cookie',()=>environment(()=>{
  const config=getConfig();for(const expiry of [new Date(Date.now()-1000),new Date(Date.now()+9*86400000)]){
    const res=response();assert.throws(()=>setSession(res,random(),expiry.toISOString(),config),error=>error.status===503);assert.equal(res.getHeader('Set-Cookie'),undefined);
  }
}));
