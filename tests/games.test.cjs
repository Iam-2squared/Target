'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const games=require('../server/games.cjs'),shop=require('../server/shop.cjs'),calculus=require('../server/calculus.cjs'),identity=require('../server/identity.cjs'),store=require('../server/store.cjs'),{handler}=require('../server/router.cjs');
const random=()=>crypto.randomBytes(32).toString('base64url'),memberId=crypto.randomUUID(),requestId=crypto.randomUUID();
const wallet=()=>({balance:0,totalIncome:100000,spent:100000,walletRevision:7,gameNet:-90000});
const round=()=>({requestId,game:'coin',stake:1000,choice:0,rulesVersion:1,outcome:[1],multiplier:0,payout:0,net:-1000,createdAt:'2026-11-09T00:00:00.000Z'});
async function fixture(fn){
 const values={NODE_ENV:'production',VERCEL:'1',TARGET_DATABASE_URL:undefined,TARGET_RPC_SECRET:random(),TARGET_COOKIE_SECRET:random(),KGS_TARGET_INTEGRATION_SECRET:random(),CALCULUS_TARGET_INTEGRATION_SECRET:undefined,
  KGS_IDENTITY_URL:'https://class.example.invalid',TARGET_ALLOWED_ORIGINS:'https://target.example.invalid',TARGET_SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',TARGET_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_'+random()};
 const previous=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]])),original={fetch:global.fetch,rpc:store.rpc,games:store.gamesRpc,member:identity.requireMember};
 for(const[key,value]of Object.entries(values))if(value===undefined)delete process.env[key];else process.env[key]=value;
 try{return await fn(values);}finally{global.fetch=original.fetch;store.rpc=original.rpc;store.gamesRpc=original.games;identity.requireMember=original.member;
  for(const[key,value]of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;}
}
function response(){return{headers:{},setHeader(key,value){this.headers[key.toLowerCase()]=value;},getHeader(key){return this.headers[key.toLowerCase()];},end(bytes){this.result=JSON.parse(String(bytes));this.writableEnded=true;}};}
test('G service authenticates and validates rewrite metadata before touching a body or storage',()=>fixture(async values=>{
 for(const path of ['/api/integrations/kgs/games/state','/api/integrations/kgs/games/play']){
  let read=false;const res=response();await handler({url:path,method:'POST',headers:{authorization:'Bearer wrong'},get body(){read=true;throw Error('must not read');}},res);assert.equal(res.statusCode,404);assert.equal(read,false);
  const rejected=response();await handler({url:path+'?payout=100000',method:'POST',headers:{authorization:'Bearer '+values.KGS_TARGET_INTEGRATION_SECRET},get body(){throw Error('query rejected before body');}},rejected);assert.equal(rejected.statusCode,400);
 }
}));
test('G inputs bind only a normalized identity and fixed rules; clients cannot assert results or credit',()=>{
 const value={memberId,name:' 名前 ',requestId,game:'coin',stake:1000,choice:0,rulesVersion:1};assert.equal(games.parseInput('play',value).name,'名前');
 for(const change of [{stake:-100},{stake:101},{stake:100001},{choice:2},{choice:'0'},{rulesVersion:'1'},{payout:2000},{outcome:[0]},{balance:100000},{memberId:'bad'}])assert.throws(()=>games.parseInput('play',{...value,...change}),error=>error.status===400);
 assert.equal(games.parseInput('play',{...value,game:'slots',choice:null}).choice,null);
 assert.throws(()=>games.parseInput('play',{...value,game:'dice',choice:0}),error=>error.status===400);
});
test('G validators check signed net, exact payout formula, private history order and current wallet',()=>{
 const input={requestId,game:'coin',stake:1000,choice:0,rulesVersion:1},value={rulesVersion:4,wallet:wallet(),round:round()};
 assert.deepEqual(games.parseResponse('play',value,input),value);
 for(const changed of [{payout:2000},{multiplier:2},{net:1000},{outcome:[0]},{choice:null},{requestId:'bad'}])assert.throws(()=>games.parseRound({...round(),...changed}),error=>error.status===503);
 for(const changed of [{balance:100},{totalIncome:-100},{gameNet:0.5},{walletRevision:-1},{walletRevision:10000000000001},{extra:0}])assert.throws(()=>games.parseWallet({...wallet(),...changed}),error=>error.status===503);
 assert.throws(()=>games.parseResponse('play',value,{...input,requestId:crypto.randomUUID()}),error=>error.status===503);
 const state={rulesVersion:4,minStake:100,maxStake:100000,stakeStep:100,wallet:wallet(),rounds:[round()]};assert.deepEqual(games.parseResponse('state',state),state);
 assert.throws(()=>games.parseResponse('state',{...state,rounds:[round(),round()]}),error=>error.status===503);
});
test('all216 slot combinations produce6 triples,90 refunds and120 losses',()=>{
 const counts=new Map();for(let a=0;a<6;a++)for(let b=0;b<6;b++)for(let c=0;c<6;c++){const multiplier=games.multiplier('slots',null,[a,b,c],1);counts.set(multiplier,(counts.get(multiplier)||0)+1);}
 assert.equal(counts.get(20),6);assert.equal(counts.get(1),90);assert.equal(counts.get(0),120);assert.equal(6*20+90,210);
 for(let choice=0;choice<2;choice++)assert.equal([0,1].reduce((sum,outcome)=>sum+games.multiplier('coin',choice,[outcome],1),0),2);
 for(let choice=1;choice<=6;choice++)assert.equal([1,2,3,4,5,6].reduce((sum,outcome)=>sum+games.multiplier('dice',choice,[outcome],1),0),6);
});
test('v2 lower returns retain uniform outcomes and validate historical v1 receipts independently',()=>{
 const coin={...round(),stake:100,rulesVersion:2,outcome:[0],multiplier:1.5,payout:150,net:50};assert.deepEqual(games.parseRound(coin),coin);
 assert.throws(()=>games.parseRound({...coin,rulesVersion:1}),error=>error.status===503);
 assert.deepEqual(games.parseRound(round()),round());
 assert.deepEqual(games.parseWallet({balance:50,totalIncome:100050,spent:100000,walletRevision:8,gameNet:-89950}),{balance:50,totalIncome:100050,spent:100000,walletRevision:8,gameNet:-89950});
 assert.throws(()=>games.parseWallet({balance:0,totalIncome:50,spent:50,walletRevision:8,gameNet:50}),error=>error.status===503);
 const counts=new Map();for(let a=0;a<6;a++)for(let b=0;b<6;b++)for(let c=0;c<6;c++){const multiplier=games.multiplier('slots',null,[a,b,c],2);counts.set(multiplier,(counts.get(multiplier)||0)+1);}
 assert.equal(counts.get(3),6);assert.equal(counts.get(1),90);assert.equal(counts.get(0),120);assert.equal(6*3+90,108);
 assert.equal(games.multiplier('coin',0,[0],2),1.5);assert.equal(games.multiplier('dice',1,[1],2),2);
});
test('historical v3 Plinko retains20 binary rows,21 bins and integer payout arithmetic',()=>{
 assert.deepEqual(games.LEGACY_PLINKO_MULTIPLIERS,[2,1.8,1.6,1.4,1.2,1,0.8,0.6,0.4,0.2,0,0.2,0.4,0.6,0.8,1,1.2,1.4,1.6,1.8,2]);
 for(let bin=0;bin<=20;bin++)for(const stake of [100,700,1000,99900,100000]){
  const outcome=Array.from({length:20},(_,i)=>i<bin?1:0),multiplier=Math.abs(bin-10)/5,payout=stake*(Math.abs(bin-10)*2)/10;
  const value={requestId,game:'plinko',stake,choice:null,rulesVersion:3,outcome,multiplier,payout,net:payout-stake,createdAt:round().createdAt};assert.deepEqual(games.parseRound(value),value);assert(Number.isSafeInteger(payout));
 }
 const request={memberId,name:'名前',requestId,game:'plinko',stake:100,choice:null,rulesVersion:3};assert.deepEqual(games.parseInput('play',request),request);
 for(const change of [{choice:0},{game:'coin',choice:0},{rulesVersion:2},{outcome:[0]}])assert.throws(()=>games.parseInput('play',{...request,...change}),error=>error.status===400);
 for(const outcome of [Array(19).fill(0),Array(21).fill(0),[...Array(19).fill(0),2],[...Array(19).fill(0),'1']])assert.throws(()=>games.multiplier('plinko',null,outcome,3),error=>error.status===503);
 assert.deepEqual(games.parseWallet({balance:70,totalIncome:100070,spent:100000,walletRevision:9,gameNet:-89930}),{balance:70,totalIncome:100070,spent:100000,walletRevision:9,gameNet:-89930});
 assert.throws(()=>games.parseWallet({balance:25,totalIncome:100025,spent:100000,walletRevision:9,gameNet:25}),error=>error.status===503);
 const counts=Array(21).fill(0);for(let path=0;path<1048576;path++){let bits=path,bin=0;while(bits){bits&=bits-1;bin++;}counts[bin]++;}
 assert.deepEqual(counts,[1,20,190,1140,4845,15504,38760,77520,125970,167960,184756,167960,125970,77520,38760,15504,4845,1140,190,20,1]);
 assert.equal(counts.reduce((sum,count,bin)=>sum+count*Math.abs(bin-10)*2,0),3695120);
});
test('photo Plinko v4 uses16 rows and the exact17-bin integer-tenths payout table',()=>{
 assert.deepEqual(games.PLINKO_TENTHS,[10000,1300,260,90,40,20,2,2,2,2,2,20,40,90,260,1300,10000]);
 assert.deepEqual(games.PLINKO_MULTIPLIERS,[1000,130,26,9,4,2,0.2,0.2,0.2,0.2,0.2,2,4,9,26,130,1000]);
 for(let bin=0;bin<=16;bin++)for(const stake of [100,700,100000]){
  const outcome=Array.from({length:16},(_,i)=>i<bin?1:0),payout=stake*games.PLINKO_TENTHS[bin]/10;
  const value={requestId,game:'plinko',stake,choice:null,rulesVersion:4,outcome,multiplier:games.PLINKO_MULTIPLIERS[bin],payout,net:payout-stake,createdAt:round().createdAt};assert.deepEqual(games.parseRound(value),value);assert(Number.isSafeInteger(payout));
 }
 const current={memberId,name:'名前',requestId,game:'plinko',stake:100,choice:null,rulesVersion:4};assert.deepEqual(games.parseInput('play',current),current);
 assert.equal(games.multiplier('plinko',null,Array(16).fill(0),4),1000);assert.equal(100000*games.PLINKO_TENTHS[0]/10,100000000);
 assert.throws(()=>games.multiplier('plinko',null,Array(20).fill(0),4),error=>error.status===503);assert.throws(()=>games.multiplier('plinko',null,Array(16).fill(0),3),error=>error.status===503);
 const counts=Array(17).fill(0);for(let path=0;path<65536;path++){let bits=path,bin=0;while(bits){bits&=bits-1;bin++;}counts[bin]++;}
 assert.deepEqual(counts,[1,16,120,560,1820,4368,8008,11440,12870,11440,8008,4368,1820,560,120,16,1]);
 assert.equal(counts.reduce((sum,count,bin)=>sum+count*games.PLINKO_TENTHS[bin],0),648652);
});
test('source outages retain valid posted game funds and do not stop receipt recovery',()=>fixture(async()=>{
 global.fetch=async()=>{throw Error('source offline');};let read=false;
 store.gamesRpc=async(action,input)=>{read=true;assert.equal(action,'play');assert.equal(input.memberId,memberId);return{rulesVersion:4,wallet:wallet(),round:round()};};
 const result=await games.perform('play',{memberId,name:'名前',requestId,game:'coin',stake:1000,choice:0,rulesVersion:1});assert.equal(read,true);assert.equal(result.wallet.balance,0);assert.equal(result.round.net,-1000);
}));
test('recorded answer responses combine immutable quiz content with a fresh net wallet and revision without source HTTP',()=>fixture(async()=>{
 let sourceCalls=0;global.fetch=async()=>{sourceCalls++;throw Error('answer must not refresh sources');};identity.requireMember=async()=>({id:memberId,name:'名前'});
 const oldResult={correct:true,awardPoints:100000,quizPoints:100000,totalPoints:190000,nextQuestion:null,bonus:null};
 store.rpc=async action=>{assert.equal(action,'answer');return oldResult;};
 store.gamesRpc=async(action,input)=>{assert.equal(action,'snapshot');assert.deepEqual(input,{memberId});return{balance:0,totalIncome:0,spent:0,walletRevision:12,gameNet:-190000};};
 const res=response();await handler({method:'POST',url:'/api/quiz/answer',headers:{origin:'https://target.example.invalid',host:'target.example.invalid','content-type':'application/json'},body:{quizId:crypto.randomUUID(),questionId:crypto.randomUUID(),choiceId:crypto.randomUUID(),requestId}},res);
 assert.equal(res.statusCode,200);assert.equal(res.result.totalPoints,0);assert.equal(res.result.walletRevision,12);assert.equal(res.result.balance,0);assert.equal(res.result.quizPoints,100000);assert.equal(oldResult.totalPoints,190000);assert.equal(sourceCalls,0);
}));
test('legacy shop snapshots preserve optional revisions and historical calculus income may exceed net income',()=>{
 const old=shop.guestWallet();assert.deepEqual(shop.validateWallet({...old,walletRevision:0}),{...old,walletRevision:0});
 for(const walletRevision of [-1,1.5,'1',10000000000001])assert.throws(()=>shop.validateWallet({...old,walletRevision}),error=>error.status===503);
 const linked={linked:true,conversionRate:10000,member:{id:memberId,name:'名前'},balance:0,totalIncome:0,calculusIncome:90000,syncPending:false};assert.deepEqual(calculus.parseStatus(linked),linked);
 const half={...linked,balance:50,totalIncome:50};assert.deepEqual(calculus.parseStatus(half),half);
 assert.throws(()=>calculus.parseStatus({...half,balance:100,totalIncome:150}),error=>error.status===503);
 assert.deepEqual(shop.validateWallet({...old,balance:50,totalIncome:50,walletRevision:8}),{...old,balance:50,totalIncome:50,walletRevision:8});
 assert.throws(()=>shop.validateWallet({...old,balance:0,totalIncome:50,spent:50,mapSpent:50}),error=>error.status===503);
});
