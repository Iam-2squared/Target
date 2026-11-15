'use strict';
const crypto=require('node:crypto');
const identity=require('./identity.cjs');
const store=require('./store.cjs');
const {generateQuestions,shuffle}=require('./questions.cjs');
const {HttpError}=require('./errors.cjs');
const BOOK_SECTIONS=Object.freeze({target1900:19,target1000:10,kobun400:4});
const ROUTES=Object.freeze({map:'GET',state:'GET',start:'POST',answer:'POST',pause:'POST',resume:'POST',abort:'POST'});
const invalid=()=>new HttpError(400,'送信内容を確認してください。','INVALID_CHALLENGE_REQUEST');
const uuid=x=>typeof x==='string'&&identity.UUID.test(x);
function input(action,body){
 const keys=action==='start'?['requestId','level']:action==='answer'?['requestId','runId','questionId','choiceId']:['requestId','runId'];
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==keys.length||keys.some(k=>!Object.hasOwn(body,k))||
   !uuid(body.requestId)||(action==='start'?(!Number.isInteger(body.level)||body.level<1||body.level>10):!uuid(body.runId))||
   (action==='answer'&&(!uuid(body.questionId)||!uuid(body.choiceId))))throw invalid();
 return body;
}
function query(url,action){
 const entries=[],seen=new Set();
 for(const [key,value] of url.searchParams){
  if(seen.has(key))throw invalid();seen.add(key);
  if(key==='route'||key==='path'){if(value!=='challenge/'+action)throw invalid();}
  else entries.push([key,value]);
 }
 if(action==='state'){
  if(entries.length!==1||entries[0][0]!=='runId'||!uuid(entries[0][1]))throw invalid();
  return {runId:entries[0][1]};
 }
 if(entries.length)throw invalid();return {};
}
function questionBlock(level){
 if(!Number.isInteger(level)||level<1||level>10)throw new HttpError(503,'出題範囲を確認できませんでした。','CHALLENGE_DATA_ERROR');
 const block=[];
 // Keep the English 5:3 ratio exact: eight questions before classical Japanese
 // joins at level 7, then the existing ten-question 5:3:2 mix.
 const mix=level<7?[['target1900',5],['target1000',3]]:[['target1900',5],['target1000',3],['kobun400',2]];
 for(const [book,count] of mix){
  const maxSection=book==='kobun400'?level-6:1+Math.floor((BOOK_SECTIONS[book]-1)*(level-1)/9);
  const questions=generateQuestions({book,direction:'japanese',count:10,from:1,to:maxSection*100,requestId:crypto.randomUUID()});
  block.push(...questions.slice(0,count).map(q=>({...q,book})));
 }
 return shuffle(block);
}
async function supply(result,actor){
 if(result?.run?.status!=='playing'||result.run.question)return result;
 const next=await store.challengeRpc('next',{...actor,runId:result.run.id,questions:questionBlock(result.run.level)});
 return {...result,...next};
}
// Clearer identities are internal RPC data; only verified public names leave this module.
async function publicMap(result){
 const candidates=result.clearerCandidates||[];
 const levels=result.levels.map(row=>({...row,clearers:candidates.filter(x=>x.level===row.level).map(x=>x.name)}));
 const {clearerCandidates,...safe}=result;
 return {...safe,levels};
}
async function dispatch({pathname,req,res,url,config,readJson}){
 const action=pathname.slice('/api/challenge/'.length);
 if(!Object.hasOwn(ROUTES,action)||req.method!==ROUTES[action])throw new HttpError(404,'見つかりません。','NOT_FOUND');
 const member=await identity.requireMember(req,res,config),token=identity.sessionToken(req,config);
 if(!token)throw new HttpError(401,'ログインしてください。','AUTHENTICATION_REQUIRED');
 const actor={memberId:member.id,name:member.name,sessionHash:identity.digest(token,'target-challenge-session',config)};
 const params=query(url,action);
 if(action==='map'){
  await store.rpc('profile',{memberId:member.id,name:member.name});
  return publicMap(await store.challengeRpc('map',actor),config);
 }
 const submitted=action==='state'?params:input(action,await readJson(req));
 if(action==='start')await store.rpc('profile',{memberId:member.id,name:member.name});
 const result=await store.challengeRpc(action,{...actor,...submitted});
 return supply(result,actor);
}
module.exports={dispatch,input,query,questionBlock,BOOK_SECTIONS};
