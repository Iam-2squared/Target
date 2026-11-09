'use strict';
const {getConfig}=require('./config.cjs');
const {HttpError}=require('./errors.cjs');
const {UUID}=require('./identity.cjs');
const store=require('./store.cjs');
const MAX=10000000000000;
const PLINKO_MULTIPLIERS=Object.freeze(Array.from({length:21},(_,bin)=>Math.abs(bin-10)/5));
const exact=(value,keys)=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const invalid=()=>new HttpError(400,'送信内容を確認してください。','INVALID_REQUEST');
const unavailable=()=>new HttpError(503,'ゲームの結果を確認できませんでした。同じ操作の結果を再確認してください。','GAMES_UNAVAILABLE');
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const money=value=>integer(value,0,MAX)&&value%10===0;
function validChoice(game,choice){return ['slots','plinko'].includes(game)?choice===null:game==='coin'?integer(choice,0,1):game==='dice'&&integer(choice,1,6);}
function multiplier(game,choice,outcome,rulesVersion=3){
  if(rulesVersion===3){
    if(game!=='plinko'||choice!==null||!Array.isArray(outcome)||outcome.length!==20||outcome.some(value=>!integer(value,0,1)))throw unavailable();
    return PLINKO_MULTIPLIERS[outcome.reduce((sum,value)=>sum+value,0)];
  }
  if(![1,2].includes(rulesVersion))throw unavailable();
  if(!['coin','dice','slots'].includes(game)||!validChoice(game,choice)||!Array.isArray(outcome)||outcome.length!==(game==='slots'?3:1)||
    outcome.some(value=>!integer(value,game==='dice'?1:0,game==='coin'?1:game==='dice'?6:5)))throw unavailable();
  if(game!=='slots')return outcome[0]===choice?(game==='coin'?(rulesVersion===1?2:1.5):(rulesVersion===1?6:2)):0;
  const[a,b,c]=outcome;return a===b&&b===c?(rulesVersion===1?20:3):a===b||a===c||b===c?1:0;
}
function parseInput(action,value){
  if(!['state','play'].includes(action)||!exact(value,action==='state'?['memberId','name']:['memberId','name','requestId','game','stake','choice','rulesVersion'])||
    typeof value.memberId!=='string'||!UUID.test(value.memberId)||typeof value.name!=='string'||!value.name.trim()||value.name.trim().length>20)throw invalid();
  if(action==='play'&&(typeof value.requestId!=='string'||!UUID.test(value.requestId)||!['coin','dice','slots','plinko'].includes(value.game)||
    !integer(value.stake,100,100000)||value.stake%100!==0||!validChoice(value.game,value.choice)||![1,2,3].includes(value.rulesVersion)||
    (value.rulesVersion===3?value.game!=='plinko':value.game==='plinko')))throw invalid();
  return {...value,memberId:value.memberId.toLowerCase(),name:value.name.trim(),...(action==='play'?{requestId:value.requestId.toLowerCase()}:{} )};
}
function parseWallet(value){
  if(!exact(value,['balance','totalIncome','spent','walletRevision','gameNet'])||!['balance','totalIncome','spent'].every(key=>money(value[key]))||
    value.balance+value.spent!==value.totalIncome||value.spent%100!==0||!integer(value.walletRevision,0,MAX)||!integer(value.gameNet,-MAX,MAX)||value.gameNet%10!==0)throw unavailable();
  return value;
}
function parseRound(value){
  if(!exact(value,['requestId','game','stake','choice','rulesVersion','outcome','multiplier','payout','net','createdAt'])||
    typeof value.requestId!=='string'||!UUID.test(value.requestId)||!integer(value.stake,100,100000)||value.stake%100!==0||![1,2,3].includes(value.rulesVersion)||
    typeof value.createdAt!=='string'||!Number.isFinite(Date.parse(value.createdAt)))throw unavailable();
  const expected=multiplier(value.game,value.choice,value.outcome,value.rulesVersion);
  const expectedPayout=value.rulesVersion===3?value.stake*(Math.abs(value.outcome.reduce((sum,bit)=>sum+bit,0)-10)*2)/10:value.stake*expected;
  if(value.multiplier!==expected||value.payout!==expectedPayout||value.net!==value.payout-value.stake)throw unavailable();
  return value;
}
function parseResponse(action,value,input){
  if(action==='state'){
    if(!exact(value,['rulesVersion','minStake','maxStake','stakeStep','wallet','rounds'])||value.rulesVersion!==3||value.minStake!==100||value.maxStake!==100000||value.stakeStep!==100||
      !Array.isArray(value.rounds)||value.rounds.length>10)throw unavailable();
    parseWallet(value.wallet);let last=Infinity;const seen=new Set();
    for(const row of value.rounds){parseRound(row);const created=Date.parse(row.createdAt);if(seen.has(row.requestId.toLowerCase())||created>last)throw unavailable();seen.add(row.requestId.toLowerCase());last=created;}
  }else{
    if(!exact(value,['rulesVersion','wallet','round'])||value.rulesVersion!==3)throw unavailable();parseWallet(value.wallet);parseRound(value.round);
    if(value.round.requestId.toLowerCase()!==input.requestId||['game','stake','choice','rulesVersion'].some(key=>value.round[key]!==input[key]))throw unavailable();
  }
  return value;
}
async function perform(action,input,config=getConfig()){
  const parsed=parseInput(action,input);
  // Posted funds remain valid during a source outage. Any late source delivery
  // is monotonic and shares the same DB lock as the eventual game settlement.
  await Promise.all([require('./calculus.cjs').refreshMembers([parsed.memberId],config).catch(()=>({syncPending:true})),require('./birthday.cjs').refresh({config})]);
  return parseResponse(action,await store.gamesRpc(action,parsed),parsed);
}
async function snapshot(memberId){
  if(typeof memberId!=='string'||!UUID.test(memberId))throw unavailable();
  return parseWallet(await store.gamesRpc('snapshot',{memberId}));
}
module.exports={parseInput,parseWallet,parseRound,parseResponse,multiplier,perform,snapshot,PLINKO_MULTIPLIERS};
