'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const shop=require('../server/shop.cjs');
const id=()=>crypto.randomUUID(),secret=crypto.randomBytes(32).toString('base64url');
const wallet=()=>({balance:20000,totalIncome:40000,spent:20000,ownedStickers:['youth','night'],price:10000,catalogVersion:1,catalogSize:4});

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
  const requestId=id(),draw={...wallet(),requestId,stickerId:'night',cost:10000};
  assert.deepEqual(shop.validateWallet(draw,{requestId}),draw);
  for(const changed of [{requestId:id()},{stickerId:'sunglasses'},{stickerId:'https://example.com/photo'}]){
    assert.throws(()=>shop.validateWallet({...draw,...changed},{requestId}),error=>error.status===503);
  }
});

test('100k price preserves all coherent mixtures of old and new immutable purchase costs',()=>{
  assert.equal(shop.PRICE,100000);
  for(let count=0;count<=shop.STICKERS.length;count++)for(let high=0;high<=Math.min(count,4);high++){
    const legacyCount=Math.min(count,4),newCount=count-legacyCount,spent=(newCount+high)*100000+(legacyCount-high)*10000;
    const value={balance:2000000-spent,totalIncome:2000000,spent,price:100000,catalogVersion:2,catalogSize:17,ownedStickers:shop.STICKERS.slice(0,count)};
    assert.deepEqual(shop.validateWallet(value),value);
  }
  for(const spent of [10000,20000,90000,190000,300000]){
    const value={balance:500000-spent,totalIncome:500000,spent,price:100000,ownedStickers:['youth','night']};
    if([20000,110000,200000].includes(spent))continue;
    assert.throws(()=>shop.validateWallet(value),error=>error.status===503);
  }
});
test('acknowledged purchase prices are exact and legacy receipts can retain their original cost',()=>{
  const member={memberId:id(),name:'表示名'},requestId=id();
  for(const expectedPrice of [10000,100000])assert.equal(shop.parseInput('draw',{...member,requestId,expectedPrice}).expectedPrice,expectedPrice);
  for(const expectedPrice of [null,undefined,'100000',0,100,99999])assert.throws(()=>shop.parseInput('draw',{...member,requestId,expectedPrice}),error=>error.status===400);
  const old={...wallet(),price:100000,requestId,stickerId:'night',cost:10000};
  assert.deepEqual(shop.validateWallet(old,{requestId}),old);
  for(const cost of [0,100,'100000',null,100000])assert.throws(()=>shop.validateWallet({...old,cost},{requestId}),error=>error.status===503);
  const missing={...old};delete missing.cost;assert.throws(()=>shop.validateWallet(missing,{requestId}),error=>error.status===503);
  assert.equal(shop.validateWallet({...missing,price:10000},{requestId}).cost,10000);
});


test('catalog rollout binds acknowledged versions and normalizes only legacy four-item receipts',()=>{
  const member={memberId:id(),name:'表示名'},requestId=id();
  for(const expectedCatalogVersion of [1,2,3,4])assert.equal(shop.parseInput('draw',{...member,requestId,expectedPrice:100000,expectedCatalogVersion}).expectedCatalogVersion,expectedCatalogVersion);
  for(const expectedCatalogVersion of [null,undefined,'2',0,5])assert.throws(()=>shop.parseInput('draw',{...member,requestId,expectedCatalogVersion}),error=>error.status===400);
  const legacy={...wallet()};delete legacy.catalogVersion;delete legacy.catalogSize;
  assert.deepEqual(shop.validateWallet(legacy),wallet());
  for(const patch of [{catalogVersion:2},{catalogSize:17},{catalogVersion:3,catalogSize:17},{catalogVersion:1,catalogSize:17}])assert.throws(()=>shop.validateWallet({...wallet(),...patch}),error=>error.status===503);
  const full={balance:300000,totalIncome:2000000,spent:1700000,price:100000,catalogVersion:2,catalogSize:17,ownedStickers:[...shop.STICKERS]};
  assert.equal(shop.validateWallet(full).ownedStickers.length,17);
  const newSticker={balance:90000,totalIncome:100000,spent:10000,price:100000,catalogVersion:2,catalogSize:17,ownedStickers:['goodnight']};
  assert.throws(()=>shop.validateWallet(newSticker),error=>error.status===503);
  assert.throws(()=>shop.validateWallet({...newSticker,balance:0,spent:100000,requestId,stickerId:'goodnight',cost:10000},{requestId}),error=>error.status===503);
  assert.throws(()=>shop.validateWallet({...full,catalogVersion:1,catalogSize:4}),error=>error.status===503);
});
