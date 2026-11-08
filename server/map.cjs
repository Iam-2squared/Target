'use strict';
const {HttpError}=require('./errors.cjs');
const store=require('./store.cjs');
const protocol=require('./map-protocol.cjs');
async function perform(action,value){
  let input;
  try{input=protocol.parseInput(action,value,{trusted:true});}
  catch{throw new HttpError(400,'マスの指定を確認してください。','INVALID_REQUEST');}
  const result=await store.mapRpc(action,input);
  try{return protocol.validateResult(action,result,input);}
  catch{throw new HttpError(503,'マップの状態を確認できませんでした。再読み込みしてください。','MAP_UNAVAILABLE');}
}
module.exports={perform};
