'use strict';
// The map protocol is mirrored in the KGS gateway. Neither side trusts
// browser identity, coordinates, prices or an unchecked upstream response.
const WIDTH=500,HEIGHT=500,UNIT_PRICE=100,OVERWRITE_PRICE=1000,MAX_CELLS=WIDTH*HEIGHT,MAX_POINTS=10000000000000;
const PALETTE=Object.freeze(['#3567d3','#dc4b4b','#e3a62f','#53a575','#8c63ca','#e982b0','#41a6ae','#354052']);
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
class InputError extends Error{constructor(){super('Invalid map input');}}
class ResultError extends Error{constructor(){super('Invalid map response');}}
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>object(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const integer=(value,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const money=value=>integer(value,0,MAX_POINTS)&&value%100===0;
function parseShape(value){
  if(!object(value))throw new InputError();
  if(value.type==='cell'&&exact(value,['type','x','y'])&&integer(value.x,0,499)&&integer(value.y,0,499))return{type:'cell',x:value.x,y:value.y};
  if(value.type==='line'&&exact(value,['type','x1','y1','x2','y2'])&&['x1','y1','x2','y2'].every(key=>integer(value[key],0,499)))return{type:'line',x1:value.x1,y1:value.y1,x2:value.x2,y2:value.y2};
  if(value.type==='square'&&exact(value,['type','x','y','size'])&&integer(value.x,0,499)&&integer(value.y,0,499)&&integer(value.size,1,500)&&value.x+value.size<=500&&value.y+value.size<=500)return{type:'square',x:value.x,y:value.y,size:value.size};
  throw new InputError();
}
function cellCount(shape){return shape.type==='cell'?1:shape.type==='square'?shape.size*shape.size:Math.max(Math.abs(shape.x2-shape.x1),Math.abs(shape.y2-shape.y1))+1;}
function parseInput(action,value,{trusted=false}={}){
  if(!['state','quote','buy'].includes(action)||!object(value))throw new InputError();
  const keys=action==='state'?(Object.hasOwn(value,'revision')?['revision']:[]):action==='quote'?['shape','color']:['requestId','shape','color','maxCost','expectedUnitPrice','expectedOverwritePrice'];
  if(trusted)keys.push('memberId','name');
  if(!exact(value,keys))throw new InputError();
  const input={};
  if(trusted){
    if(typeof value.memberId!=='string'||!UUID.test(value.memberId)||typeof value.name!=='string'||!value.name.trim()||value.name.trim().length>20)throw new InputError();
    input.memberId=value.memberId.toLowerCase();input.name=value.name.trim();
  }
  if(action==='state'){
    if(Object.hasOwn(value,'revision')){if(!integer(value.revision))throw new InputError();input.revision=value.revision;}
    return input;
  }
  input.shape=parseShape(value.shape);
  if(!integer(value.color,1,PALETTE.length))throw new InputError();
  input.color=value.color;
  if(action==='buy'){
    if(typeof value.requestId!=='string'||!UUID.test(value.requestId)||!integer(value.maxCost,0,MAX_CELLS*OVERWRITE_PRICE)||value.maxCost%UNIT_PRICE!==0||value.expectedUnitPrice!==UNIT_PRICE||value.expectedOverwritePrice!==OVERWRITE_PRICE)throw new InputError();
    input.requestId=value.requestId.toLowerCase();input.maxCost=value.maxCost;input.expectedUnitPrice=UNIT_PRICE;input.expectedOverwritePrice=OVERWRITE_PRICE;
  }
  return input;
}
function wallet(value){
  if(!object(value)||!['balance','totalIncome','spent','mapSpent'].every(key=>money(value[key]))||value.balance+value.spent!==value.totalIncome||value.mapSpent>value.spent)throw new ResultError();
  return{balance:value.balance,totalIncome:value.totalIncome,spent:value.spent,mapSpent:value.mapSpent};
}
function pixelData(value,size){
  if(typeof value!=='string'||value.length!==4*Math.ceil(size/3)||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))throw new ResultError();
  const bytes=Buffer.from(value,'base64');
  if(bytes.length!==size||bytes.toString('base64')!==value||bytes.some(code=>code>PALETTE.length))throw new ResultError();
  return value;
}
function validateResult(action,value,input){
  if(!object(value)||!integer(value.revision))throw new ResultError();
  const result={...wallet(value),revision:value.revision};
  if(action==='state'){
    if(value.width!==WIDTH||value.height!==HEIGHT||value.unitPrice!==UNIT_PRICE||value.overwritePrice!==OVERWRITE_PRICE||!Array.isArray(value.palette)||value.palette.length!==PALETTE.length||value.palette.some((color,index)=>color!==PALETTE[index])||!Array.isArray(value.rows)||value.rows.length>HEIGHT)throw new ResultError();
    let pixels=null;const rows=[];
    if(value.pixels!==null){pixels=pixelData(value.pixels,MAX_CELLS);if(value.rows.length)throw new ResultError();}
    else{
      if(!Object.hasOwn(input,'revision')||input.revision>value.revision)throw new ResultError();
      const seen=new Set();
      for(const row of value.rows){if(!exact(row,['y','pixels'])||!integer(row.y,0,499)||seen.has(row.y))throw new ResultError();seen.add(row.y);rows.push({y:row.y,pixels:pixelData(row.pixels,WIDTH)});}
      if(input.revision===value.revision&&rows.length)throw new ResultError();
    }
    return{...result,width:WIDTH,height:HEIGHT,unitPrice:UNIT_PRICE,overwritePrice:OVERWRITE_PRICE,palette:[...PALETTE],pixels,rows};
  }
  let shape;try{shape=parseShape(value.shape);}catch{throw new ResultError();}
  const count=cellCount(input.shape);
  if(JSON.stringify(shape)!==JSON.stringify(input.shape)||value.color!==input.color||value.count!==count||!integer(value.newCount,0,count)||!integer(value.takeoverCount,0,count)||value.newCount+value.takeoverCount>count||value.cost!==value.newCount*UNIT_PRICE+value.takeoverCount*OVERWRITE_PRICE)throw new ResultError();
  Object.assign(result,{shape,color:input.color,count,newCount:value.newCount,takeoverCount:value.takeoverCount,cost:value.cost});
  if(action==='quote'){
    if(!integer(value.ownCount,0,count)||value.newCount+value.ownCount+value.takeoverCount!==count||value.ownerName!==null&&(typeof value.ownerName!=='string'||!value.ownerName.trim()||value.ownerName.length>20))throw new ResultError();
    return{...result,ownCount:value.ownCount,ownerName:value.ownerName};
  }
  if(action!=='buy'||typeof value.requestId!=='string'||!UUID.test(value.requestId)||value.requestId.toLowerCase()!==input.requestId||typeof value.replayed!=='boolean'||value.cost>input.maxCost||value.cost>value.mapSpent)throw new ResultError();
  return{...result,requestId:input.requestId,replayed:value.replayed};
}
module.exports={WIDTH,HEIGHT,UNIT_PRICE,OVERWRITE_PRICE,MAX_CELLS,MAX_POINTS,PALETTE,UUID,InputError,ResultError,parseShape,cellCount,parseInput,validateResult};
