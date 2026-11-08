'use strict';
const {HttpError}=require('./errors.cjs');
const store=require('./store.cjs');
const protocol=require('./territory-protocol.cjs');
async function perform(action,value){
  let input;
  try{input=protocol.parseInput(action,value,{trusted:true});}
  catch{throw new HttpError(400,'操作を確認してください。','INVALID_REQUEST');}
  const result=await store.territoryRpc(action,input);
  try{return protocol.validateResult(action,result,input);}
  catch{throw new HttpError(503,'領土戦の状態を確認できませんでした。再読み込みしてください。','TERRITORY_UNAVAILABLE');}
}
module.exports={perform};
