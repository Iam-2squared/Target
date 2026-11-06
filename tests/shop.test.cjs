'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const shop=require('../server/shop.cjs');
const id=()=>crypto.randomUUID(),secret=crypto.randomBytes(32).toString('base64url');
const wallet=()=>({balance:20000,totalIncome:40000,spent:20000,ownedStickers:['youth','night'],price:10000});

test('KGS wallet bridge requires the separate service bearer before trusting a member assertion',()=>{
  const config={integrationSecret:secret};
  shop.authorize({headers:{authorization:'Bearer '+secret}},config);
  for(const authorization of [undefined,'',secret,'Bearer '+secret+'x','Bearer '+secret.toUpperCase(),'a'.repeat(9000)]){
    assert.throws(()=>shop.authorize({headers:{authorization}},config),error=>error.status===404&&error.code==='NOT_FOUND');
  }
});
test('service inputs cannot assert a balance, award, owner override, or sticker result',()=>{
  const member={memberId:id(),name:' 表示名 '},draw={...member,requestId:id()};
  assert.deepEqual(shop.parseInput('wallet',member),{memberId:member.memberId,name:'表示名'});
  assert.equal(shop.parseInput('draw',draw).requestId,draw.requestId);
  for(const input of [{...draw,stickerId:'youth'},{...draw,balance:100000},{...draw,name:''},{...draw,memberId:'../member'},{...draw,requestId:'bad'},[],null]){
    assert.throws(()=>shop.parseInput('draw',input),error=>error.status===400);
  }
});
test('wallet response requires coherent bounded income, spend and permanent ownership',()=>{
  assert.deepEqual(shop.validateWallet(wallet()),wallet());
  for(const changed of [
    {balance:20001},{totalIncome:39000},{spent:10000},{spent:-10000},{spent:20000000000000},
    {price:100},{ownedStickers:['youth','youth']},{ownedStickers:['youth','evil']},
    {ownedStickers:[]},{ownedStickers:['youth']},{totalIncome:NaN}
  ])assert.throws(()=>shop.validateWallet({...wallet(),...changed}),error=>error.status===503);
});
test('draw acknowledgement must match the requested purchase and include its permanently owned result',()=>{
  const requestId=id(),draw={...wallet(),requestId,stickerId:'night'};
  assert.deepEqual(shop.validateWallet(draw,{requestId}),draw);
  for(const changed of [{requestId:id()},{stickerId:'sunglasses'},{stickerId:'https://example.com/photo'}]){
    assert.throws(()=>shop.validateWallet({...draw,...changed},{requestId}),error=>error.status===503);
  }
});
