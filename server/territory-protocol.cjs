'use strict';
// Mirrored in KGS: requests cannot assert authority and upstream responses are
// bounded, coherent game snapshots rather than trusted arbitrary JSON.
const SIZE=50,MAX_PLAYERS=40,MAX_TROOPS=1000,MAX_POINTS=10000000000000,RULES_VERSION=1;
const RULES=Object.freeze({claimCost:1000,troopPrice:1000,attackCost:1000,maxTroops:1000,startTroops:10,castleGuard:8,landPointsPerMinute:1,castlePointsPerMinute:10});
const CASTLES=Object.freeze([[12,12],[37,12],[25,25],[12,37],[37,37]].map(([x,y])=>Object.freeze({x,y})));
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const TYPES=Object.freeze(['join','claim','reinforce','move','attack']);
const RESULTS=Object.freeze(['joined','claimed','reinforced','moved','captured','defended','neutralized']);
class InputError extends Error{constructor(){super('Invalid territory input');}}
class ResultError extends Error{constructor(){super('Invalid territory response');}}
const object=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>object(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const integer=(v,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const coord=v=>integer(v,0,SIZE-1),slot=v=>integer(v,1,MAX_PLAYERS),version=v=>integer(v);
function seasonId(v){return typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;}
function timestamp(v){return typeof v==='string'&&v.length>=20&&v.length<=40&&Number.isFinite(Date.parse(v));}
function home(s){return{x:3+((s-1)%8)*6,y:5+Math.floor((s-1)/8)*10};}
const castle=(x,y)=>CASTLES.some(c=>c.x===x&&c.y===y);
function parseCommand(v){
  if(!object(v)||!TYPES.includes(v.type))throw new InputError();
  const fields={join:['type'],claim:['type','x','y','expectedTargetVersion'],reinforce:['type','x','y','troops','expectedTargetVersion'],move:['type','fromX','fromY','x','y','troops','expectedSourceVersion','expectedTargetVersion'],attack:['type','fromX','fromY','x','y','troops','expectedSourceVersion','expectedTargetVersion']}[v.type];
  if(!exact(v,fields))throw new InputError();
  const result={};
  for(const field of fields){const value=v[field];if(field==='type'){}else if(['x','y','fromX','fromY'].includes(field)){if(!coord(value))throw new InputError();}else if(field==='troops'){if(!integer(value,1,MAX_TROOPS))throw new InputError();}else if(!version(value))throw new InputError();result[field]=value;}
  return result;
}
function cost(command){return command.type==='reinforce'?command.troops*RULES.troopPrice:command.type==='claim'?RULES.claimCost:command.type==='attack'?RULES.attackCost:0;}
function parseInput(action,value,{trusted=false}={}){
  if(!['state','quote','act'].includes(action)||!object(value))throw new InputError();
  const conditional=Object.hasOwn(value,'seasonId')||Object.hasOwn(value,'revision');
  const keys=action==='state'?(conditional?['seasonId','revision',...(Object.hasOwn(value,'summaryMinute')?['summaryMinute']:[])]:[]):action==='quote'?['seasonId','rulesVersion','command']:['seasonId','rulesVersion','command','requestId','maxCost'];
  if(trusted)keys.push('memberId','name');if(!exact(value,keys))throw new InputError();
  const result={};
  if(trusted){if(typeof value.memberId!=='string'||!UUID.test(value.memberId)||typeof value.name!=='string'||!value.name.trim()||value.name.trim().length>20)throw new InputError();result.memberId=value.memberId.toLowerCase();result.name=value.name.trim();}
  if(action==='state'){if(conditional){if(!seasonId(value.seasonId)||!version(value.revision))throw new InputError();result.seasonId=value.seasonId;result.revision=value.revision;if(Object.hasOwn(value,'summaryMinute')){if(!version(value.summaryMinute))throw new InputError();result.summaryMinute=value.summaryMinute;}}return result;}
  if(!seasonId(value.seasonId)||value.rulesVersion!==RULES_VERSION)throw new InputError();
  result.seasonId=value.seasonId;result.rulesVersion=RULES_VERSION;result.command=parseCommand(value.command);
  if(action==='act'){if(typeof value.requestId!=='string'||!UUID.test(value.requestId)||!integer(value.maxCost,0,1000000)||value.maxCost%1000!==0)throw new InputError();result.requestId=value.requestId.toLowerCase();result.maxCost=value.maxCost;}
  return result;
}
function wallet(value){
  if(!object(value)||!['balance','totalIncome','spent','mapSpent'].every(key=>integer(value[key],0,MAX_POINTS))||value.balance+value.spent!==value.totalIncome||value.mapSpent>value.spent||value.spent%100!==0||value.mapSpent%100!==0)throw new ResultError();
  return{balance:value.balance,totalIncome:value.totalIncome,spent:value.spent,mapSpent:value.mapSpent};
}
function preview(value,command){
  if(!object(value)||!RESULTS.includes(value.result)||!integer(value.targetRemaining,0,MAX_TROOPS)||!integer(value.targetOwnerSlot,0,MAX_PLAYERS))throw new ResultError();
  const result=value.result;
  if(['join','claim','reinforce'].includes(command.type)){if(value.sourceRemaining!==null||result!=={join:'joined',claim:'claimed',reinforce:'reinforced'}[command.type]||!slot(value.targetOwnerSlot)||value.targetRemaining<1)throw new ResultError();if(command.type==='claim'&&value.targetRemaining!==1)throw new ResultError();if(command.type==='reinforce'&&value.targetRemaining<=command.troops)throw new ResultError();}
  else{if(!integer(value.sourceRemaining,1,MAX_TROOPS-1))throw new ResultError();if(command.type==='move'){if(result!=='moved'||!slot(value.targetOwnerSlot)||value.targetRemaining<=command.troops)throw new ResultError();}else if(!['captured','defended','neutralized'].includes(result)||result==='captured'&&(!slot(value.targetOwnerSlot)||value.targetRemaining<1||value.targetRemaining>command.troops)||result==='defended'&&value.targetRemaining<1||result==='neutralized'&&(value.targetOwnerSlot!==0||value.targetRemaining!==0))throw new ResultError();}
  return{result,sourceRemaining:value.sourceRemaining,targetRemaining:value.targetRemaining,targetOwnerSlot:value.targetOwnerSlot};
}
function event(value){
  if(!object(value)||!integer(value.id,1)||!TYPES.includes(value.kind)||!slot(value.actorSlot)||value.defenderSlot!==null&&!slot(value.defenderSlot)||!coord(value.x)||!coord(value.y)||!integer(value.troops,0,MAX_TROOPS)||!integer(value.cost,0,1000000)||value.cost%1000!==0||!timestamp(value.createdAt)||!RESULTS.includes(value.result))throw new ResultError();
  const sourced=['move','attack'].includes(value.kind);if(sourced?(!coord(value.fromX)||!coord(value.fromY)||Math.abs(value.fromX-value.x)+Math.abs(value.fromY-value.y)!==1):value.fromX!==null||value.fromY!==null)throw new ResultError();
  if(value.kind!=='attack'&&value.defenderSlot!==null||value.kind==='attack'&&value.defenderSlot===value.actorSlot)throw new ResultError();
  const expected={join:['joined'],claim:['claimed'],reinforce:['reinforced'],move:['moved'],attack:['captured','defended','neutralized']}[value.kind];if(!expected.includes(value.result)||value.cost!==cost({type:value.kind,troops:value.troops}))throw new ResultError();
  return{id:value.id,kind:value.kind,actorSlot:value.actorSlot,defenderSlot:value.defenderSlot,fromX:value.fromX,fromY:value.fromY,x:value.x,y:value.y,troops:value.troops,result:value.result,cost:value.cost,createdAt:value.createdAt};
}
function players(values){
  if(!Array.isArray(values)||values.length>MAX_PLAYERS)throw new ResultError();const slots=new Set(),ids=new Set(),result=[];
  for(const p of values){if(!object(p)||!slot(p.slot)||slots.has(p.slot)||typeof p.memberId!=='string'||!UUID.test(p.memberId)||ids.has(p.memberId.toLowerCase())||typeof p.name!=='string'||!p.name.trim()||p.name.length>20||!object(p.home)||p.home.x!==home(p.slot).x||p.home.y!==home(p.slot).y||!integer(p.landCount,1,SIZE*SIZE)||!integer(p.castleCount,0,CASTLES.length)||p.castleCount>p.landCount||!integer(p.score,0,MAX_POINTS))throw new ResultError();slots.add(p.slot);ids.add(p.memberId.toLowerCase());result.push({slot:p.slot,memberId:p.memberId.toLowerCase(),name:p.name,home:home(p.slot),landCount:p.landCount,castleCount:p.castleCount,score:p.score});}
  for(let i=1;i<result.length;i++){const a=result[i-1],b=result[i];if(a.score<b.score||a.score===b.score&&(a.landCount<b.landCount||a.landCount===b.landCount&&a.slot>b.slot))throw new ResultError();}
  return result;
}
function validateState(value,input){
  if(!object(value)||value.rulesVersion!==RULES_VERSION||value.width!==SIZE||value.height!==SIZE||value.maxPlayers!==MAX_PLAYERS||!object(value.rules)||Object.keys(RULES).some(k=>value.rules[k]!==RULES[k])||!object(value.season)||!seasonId(value.season.id)||!timestamp(value.season.startsAt)||!timestamp(value.season.endsAt)||Date.parse(value.season.endsAt)-Date.parse(value.season.startsAt)!==7*86400000||!timestamp(value.serverNow)||!version(value.revision)||!version(value.summaryMinute)||value.summaryMinute!==Math.floor(Date.parse(value.serverNow)/60000)||value.selfSlot!==null&&!slot(value.selfSlot))throw new ResultError();
  const sameSeason=input.seasonId===value.season.id,conditional=sameSeason&&version(input.revision)&&input.revision<=value.revision;
  const summariesNull=value.players===null&&value.events===null&&value.notifications===null;
  if(summariesNull&&(!sameSeason||input.revision!==value.revision||input.summaryMinute!==value.summaryMinute)||!summariesNull&&(value.players===null||value.events===null||value.notifications===null))throw new ResultError();
  const members=summariesNull?null:players(value.players),bySlot=members?new Map(members.map(p=>[p.slot,p])):null;
  if(members){if(value.selfSlot!==null&&!bySlot.has(value.selfSlot))throw new ResultError();if(input.memberId){const self=members.find(p=>p.memberId===input.memberId.toLowerCase());if(value.selfSlot!==(self?.slot??null))throw new ResultError();}}
  const tile=(t,index)=>{
    const x=index%SIZE,y=Math.floor(index/SIZE);if(!Array.isArray(t)||t.length!==3||!integer(t[0],0,MAX_PLAYERS)||!integer(t[1],0,MAX_TROOPS)||!version(t[2])||t[2]>value.revision||t[0]>0&&((bySlot&&!bySlot.has(t[0]))||t[1]<1)||t[0]===0&&t[1]>(castle(x,y)?RULES.castleGuard:0))throw new ResultError();
    for(let s=1;s<=MAX_PLAYERS;s++){const h=home(s);if(h.x!==x||h.y!==y)continue;const exists=bySlot?bySlot.has(s):t[0]>0;if(exists?t[0]!==s||t[1]<1:t[0]!==0||t[1]!==0)throw new ResultError();break;}
    return[...t];
  };
  if(!Array.isArray(value.changes)||value.changes.length>SIZE*SIZE)throw new ResultError();let tiles=null;const changes=[];
  if(value.tiles===null){
    if(!conditional)throw new ResultError();const seen=new Set();for(const change of value.changes){if(!Array.isArray(change)||change.length!==4||!integer(change[0],0,SIZE*SIZE-1)||seen.has(change[0]))throw new ResultError();seen.add(change[0]);const t=tile(change.slice(1),change[0]);if(t[2]<=input.revision)throw new ResultError();changes.push([change[0],...t]);}
    if(input.revision===value.revision&&changes.length||input.revision<value.revision&&!changes.length)throw new ResultError();
  }else{
    if(conditional||summariesNull||value.changes.length||!Array.isArray(value.tiles)||value.tiles.length!==SIZE*SIZE)throw new ResultError();tiles=value.tiles.map(tile);const counts=new Map(members.map(p=>[p.slot,{land:0,castles:0}]));
    for(let i=0;i<tiles.length;i++){const t=tiles[i];if(t[0]){counts.get(t[0]).land++;if(castle(i%SIZE,Math.floor(i/SIZE)))counts.get(t[0]).castles++;}}
    for(const p of members){const c=counts.get(p.slot);if(c.land!==p.landCount||c.castles!==p.castleCount)throw new ResultError();}
  }
  const parseEvents=(list,max)=>{if(!Array.isArray(list)||list.length>max)throw new ResultError();let previous=Number.MAX_SAFE_INTEGER;const seen=new Set();return list.map(raw=>{const e=event(raw);if(e.id>=previous||seen.has(e.id)||!bySlot.has(e.actorSlot)||e.defenderSlot!==null&&!bySlot.has(e.defenderSlot))throw new ResultError();previous=e.id;seen.add(e.id);return e;});};
  const events=summariesNull?null:parseEvents(value.events,20),notifications=summariesNull?null:parseEvents(value.notifications,10);if(notifications?.some(e=>e.kind!=='attack'||e.defenderSlot!==value.selfSlot))throw new ResultError();
  return{rulesVersion:RULES_VERSION,width:SIZE,height:SIZE,maxPlayers:MAX_PLAYERS,rules:{...RULES},season:{id:value.season.id,startsAt:value.season.startsAt,endsAt:value.season.endsAt},serverNow:value.serverNow,revision:value.revision,summaryMinute:value.summaryMinute,selfSlot:value.selfSlot,...wallet(value),players:members,tiles,changes,events,notifications};
}
function validateResult(action,value,input){
  if(action==='state')return validateState(value,input);
  if(!['quote','act'].includes(action)||!object(value)||value.rulesVersion!==RULES_VERSION||value.seasonId!==input.seasonId||!version(value.revision)||value.cost!==cost(input.command))throw new ResultError();
  let command;try{command=parseCommand(value.command);}catch{throw new ResultError();}if(JSON.stringify(command)!==JSON.stringify(input.command))throw new ResultError();
  const result={rulesVersion:RULES_VERSION,seasonId:value.seasonId,revision:value.revision,command,cost:value.cost,preview:preview(value.preview,command),...wallet(value)};
  if(action==='quote')return result;
  if(typeof value.requestId!=='string'||!UUID.test(value.requestId)||value.requestId.toLowerCase()!==input.requestId||typeof value.replayed!=='boolean'||value.cost>input.maxCost||value.cost>value.mapSpent)throw new ResultError();
  const e=value.event===null?null:event(value.event);if(e===null?command.type!=='join':e.kind!==command.type||e.cost!==value.cost||e.result!==result.preview.result||command.type!=='join'&&(e.x!==command.x||e.y!==command.y))throw new ResultError();
  return{...result,requestId:value.requestId.toLowerCase(),replayed:value.replayed,event:e};
}
module.exports={SIZE,MAX_PLAYERS,MAX_TROOPS,MAX_POINTS,RULES_VERSION,RULES,CASTLES,UUID,InputError,ResultError,home,castle,seasonId,parseCommand,parseInput,cost,validateResult};
