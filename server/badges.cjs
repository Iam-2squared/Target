'use strict';
const {HttpError}=require('./errors.cjs');
const store=require('./store.cjs');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const BADGES=new Set([
  ...[['target1900',19],['target1000',10],['kobun400',4]].flatMap(([book,count])=>
    Array.from({length:count},(_,i)=>'sec:'+book+':'+String(i+1).padStart(2,'0'))),
  'book:target1900','book:target1000','book:kobun400','grand:all'
]);
const fail=()=>new HttpError(503,'定着バッジの確認ができませんでした。','BADGE_UNAVAILABLE');
function input(body){
 if(!body||typeof body!=='object'||Array.isArray(body)||
  Object.keys(body).length!==2||!Object.hasOwn(body,'memberId')||!Object.hasOwn(body,'name')||
  typeof body.memberId!=='string'||!UUID.test(body.memberId)||
  typeof body.name!=='string'||!body.name.trim()||body.name.trim().length>20)
  throw new HttpError(400,'送信内容を確認してください。','INVALID_REQUEST');
 return {memberId:body.memberId.toLowerCase(),name:body.name.trim()};
}
function validate(value){
 if(value?.ok!==true||!Array.isArray(value.earnedIds)||value.earnedIds.length>37||
   new Set(value.earnedIds).size!==value.earnedIds.length||
   value.earnedIds.some(id=>typeof id!=='string'||!BADGES.has(id))||
   !Number.isSafeInteger(value.completedSections)||value.completedSections<0||value.completedSections>33||
   value.sectionTotal!==33)throw fail();
 return {earnedIds:value.earnedIds,completedSections:value.completedSections,sectionTotal:33};
}
async function perform(body){
 const actor=input(body);
 return validate(await store.badgesRpc('list',actor));
}
module.exports={perform,validate,input,BADGES};
