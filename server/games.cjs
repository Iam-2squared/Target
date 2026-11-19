'use strict';
const {HttpError}=require('./errors.cjs');
const {UUID}=require('./identity.cjs');
const store=require('./store.cjs');
const MAX=10000000000000;
const LEGACY_PLINKO_MULTIPLIERS=Object.freeze(Array.from({length:21},(_,bin)=>Math.abs(bin-10)/5));
const PLINKO_FOUR_TENTHS=Object.freeze([10000,1300,260,90,40,20,2,2,2,2,2,20,40,90,260,1300,10000]);
const PLINKO_TENTHS=Object.freeze([10000,1300,260,90,40,20,10,2,2,2,10,20,40,90,260,1300,10000]);
const PLINKO_FOUR_MULTIPLIERS=Object.freeze(PLINKO_FOUR_TENTHS.map(value=>value/10));
const PLINKO_MULTIPLIERS=Object.freeze(PLINKO_TENTHS.map(value=>value/10));
const exact=(value,keys)=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const invalid=()=>new HttpError(400,'送信内容を確認してください。','INVALID_REQUEST');
const unavailable=()=>new HttpError(503,'ゲームの結果を確認できませんでした。同じ操作の結果を再確認してください。','GAMES_UNAVAILABLE');
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const money=value=>integer(value,0,MAX)&&value%10===0;
function validChoice(game,choice){return ['slots','plinko'].includes(game)?choice===null:game==='coin'?integer(choice,0,1):game==='dice'&&integer(choice,1,6);}
function multiplier(game,choice,outcome,rulesVersion=5){
  if([3,4,5].includes(rulesVersion)){
    if(game!=='plinko'||choice!==null||!Array.isArray(outcome)||outcome.length!==(rulesVersion===3?20:16)||outcome.some(value=>!integer(value,0,1)))throw unavailable();
    return (rulesVersion===5?PLINKO_MULTIPLIERS:rulesVersion===4?PLINKO_FOUR_MULTIPLIERS:LEGACY_PLINKO_MULTIPLIERS)[outcome.reduce((sum,value)=>sum+value,0)];
  }
  if(![1,2].includes(rulesVersion))throw unavailable();
  if(!['coin','dice','slots'].includes(game)||!validChoice(game,choice)||!Array.isArray(outcome)||outcome.length!==(game==='slots'?3:1)||
    outcome.some(value=>!integer(value,game==='dice'?1:0,game==='coin'?1:game==='dice'?6:5)))throw unavailable();
  if(game!=='slots')return outcome[0]===choice?(game==='coin'?(rulesVersion===1?2:1.5):(rulesVersion===1?6:2)):0;
  const[a,b,c]=outcome;return a===b&&b===c?(rulesVersion===1?20:3):a===b||a===c||b===c?1:0;
}
function parseInput(action,value){
  const keys=action==='state'?['memberId','name']:['memberId','name','requestId','game','stake','choice','rulesVersion',...(action==='batch'?['count']:[])];
  if(!['state','play','batch'].includes(action)||!exact(value,keys)||
    typeof value.memberId!=='string'||!UUID.test(value.memberId)||typeof value.name!=='string'||!value.name.trim()||value.name.trim().length>20)throw invalid();
  if(action!=='state'&&(typeof value.requestId!=='string'||!UUID.test(value.requestId)||!['coin','dice','slots','plinko'].includes(value.game)||
    !integer(value.stake,100,100000)||value.stake%100!==0||!validChoice(value.game,value.choice)||![1,2,3,4,5].includes(value.rulesVersion)||
    (value.rulesVersion>=3?value.game!=='plinko':value.game==='plinko')))throw invalid();
  if(action==='batch'&&(value.game!=='plinko'||value.choice!==null||![4,5].includes(value.rulesVersion)||!integer(value.count,1,100)))throw invalid();
  return {...value,memberId:value.memberId.toLowerCase(),name:value.name.trim(),...(action!=='state'?{requestId:value.requestId.toLowerCase()}:{} )};
}
function childId(parent,ordinal){
  if(typeof parent!=='string'||!UUID.test(parent)||!integer(ordinal,1,100))throw unavailable();
  const hex=parent.toLowerCase().replace(/-/g,''),tail=((parseInt(hex.slice(24),16)^ordinal)>>>0).toString(16).padStart(8,'0'),value=hex.slice(0,24)+tail;
  return [value.slice(0,8),value.slice(8,12),value.slice(12,16),value.slice(16,20),value.slice(20)].join('-');
}
function parseWallet(value){
  if(!exact(value,['balance','totalIncome','spent','walletRevision','gameNet'])||!['balance','totalIncome','spent'].every(key=>money(value[key]))||
    value.balance+value.spent!==value.totalIncome||value.spent%100!==0||!integer(value.walletRevision,0,MAX)||!integer(value.gameNet,-MAX,MAX)||value.gameNet%10!==0)throw unavailable();
  return value;
}
function parseRound(value){
  if(!exact(value,['requestId','game','stake','choice','rulesVersion','outcome','multiplier','payout','net','createdAt'])||
    typeof value.requestId!=='string'||!UUID.test(value.requestId)||!integer(value.stake,100,100000)||value.stake%100!==0||![1,2,3,4,5].includes(value.rulesVersion)||
    typeof value.createdAt!=='string'||!Number.isFinite(Date.parse(value.createdAt)))throw unavailable();
  const expected=multiplier(value.game,value.choice,value.outcome,value.rulesVersion);
  const bin=value.outcome.reduce((sum,bit)=>sum+bit,0);
  const expectedPayout=value.rulesVersion>=4?value.stake*(value.rulesVersion===5?PLINKO_TENTHS:PLINKO_FOUR_TENTHS)[bin]/10:value.rulesVersion===3?value.stake*(Math.abs(bin-10)*2)/10:value.stake*expected;
  if(value.multiplier!==expected||value.payout!==expectedPayout||value.net!==value.payout-value.stake)throw unavailable();
  return value;
}
function parseBatch(value,input){
  if(!exact(value,['requestId','game','stake','choice','rulesVersion','count','totalStake','totalPayout','net','createdAt','rounds'])||
    typeof value.requestId!=='string'||!UUID.test(value.requestId)||value.game!=='plinko'||!integer(value.stake,100,100000)||value.stake%100!==0||value.choice!==null||![4,5].includes(value.rulesVersion)||
    !integer(value.count,1,100)||value.totalStake!==value.stake*value.count||typeof value.createdAt!=='string'||!Number.isFinite(Date.parse(value.createdAt))||
    !Array.isArray(value.rounds)||value.rounds.length!==value.count)throw unavailable();
  let payout=0,net=0;
  for(let index=0;index<value.rounds.length;index++){
    const round=parseRound(value.rounds[index]);
    if(round.requestId.toLowerCase()!==childId(value.requestId,index+1)||round.game!==value.game||round.stake!==value.stake||round.choice!==null||round.rulesVersion!==value.rulesVersion||round.createdAt!==value.createdAt)throw unavailable();
    payout+=round.payout;net+=round.net;
  }
  if(value.totalPayout!==payout||value.net!==net||value.net!==value.totalPayout-value.totalStake||
    (input&&(value.requestId.toLowerCase()!==input.requestId||['game','stake','choice','rulesVersion','count'].some(key=>value[key]!==input[key]))))throw unavailable();
  return value;
}
function parseResponse(action,value,input){
  if(action==='state'){
    if(!exact(value,['rulesVersion','minStake','maxStake','stakeStep','wallet','rounds'])||![4,5].includes(value.rulesVersion)||value.minStake!==100||value.maxStake!==100000||value.stakeStep!==100||
      !Array.isArray(value.rounds)||value.rounds.length>10)throw unavailable();
    parseWallet(value.wallet);let last=Infinity;const seen=new Set();
    for(const row of value.rounds){parseRound(row);if(row.rulesVersion>value.rulesVersion)throw unavailable();const created=Date.parse(row.createdAt);if(seen.has(row.requestId.toLowerCase())||created>last)throw unavailable();seen.add(row.requestId.toLowerCase());last=created;}
  }else if(action==='batch'){
    if(!exact(value,['rulesVersion','wallet','batch'])||![4,5].includes(value.rulesVersion)||(input?.rulesVersion===5&&value.rulesVersion!==5))throw unavailable();parseWallet(value.wallet);if(value.batch?.rulesVersion>value.rulesVersion)throw unavailable();parseBatch(value.batch,input);
  }else{
    if(!exact(value,['rulesVersion','wallet','round'])||![4,5].includes(value.rulesVersion)||(input?.rulesVersion===5&&value.rulesVersion!==5))throw unavailable();parseWallet(value.wallet);if(value.round?.rulesVersion>value.rulesVersion)throw unavailable();parseRound(value.round);
    if(value.round.requestId.toLowerCase()!==input.requestId||['game','stake','choice','rulesVersion'].some(key=>value.round[key]!==input[key]))throw unavailable();
  }
  return value;
}
async function perform(){
  throw new HttpError(410,'ギャンブル機能は終了しました。','GAMES_REMOVED');
}
async function snapshot(memberId){
  if(typeof memberId!=='string'||!UUID.test(memberId))throw unavailable();
  return parseWallet(await store.gamesRpc('snapshot',{memberId}));
}
module.exports={parseInput,parseWallet,parseRound,parseBatch,childId,parseResponse,multiplier,perform,snapshot,PLINKO_MULTIPLIERS,PLINKO_TENTHS,PLINKO_FOUR_MULTIPLIERS,PLINKO_FOUR_TENTHS,LEGACY_PLINKO_MULTIPLIERS};
