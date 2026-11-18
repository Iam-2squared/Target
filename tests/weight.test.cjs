'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const weight=require('../server/weight.cjs');
const member={memberId:crypto.randomUUID(),name:' 会員 '};
const credit={...member,sessionId:'session_12345678',reps:7};
const status={weightIncome:7000,totalIncome:27000,balance:7000};
test('Weight assertions are bounded and cannot supply any money or another account selector',()=>{
 assert.deepEqual(weight.parseInput('status',member),{...member,name:'会員'});
 assert.deepEqual(weight.parseInput('credit',credit),{...credit,name:'会員'});
 for(const input of[null,[],{}, {...credit,amount:7000},{...credit,totalIncome:7000},{...credit,memberId:'bad'},
   {...credit,name:''},{...credit,reps:0},{...credit,reps:5001},{...credit,reps:1.2},{...credit,reps:'7'},
   {...credit,sessionId:'short'},{...credit,sessionId:'../session_12345678'},{...credit,sessionId:'x'.repeat(81)}]){
  assert.throws(()=>weight.parseInput('credit',input),e=>e.status===400);
 }
 for(const action of['wallet','draw','rate',undefined])assert.throws(()=>weight.parseInput(action,member),e=>e.status===400);
 for(const reps of[1,5000])assert.equal(weight.parseInput('credit',{...credit,reps}).reps,reps);
});
test('Weight earnings use authoritative coherent wallet totals and stable receipt identity',()=>{
 assert.deepEqual(weight.validateResult('status',status),status);
 const result={...status,sessionId:credit.sessionId,reps:7,creditedAmount:7000,replayed:false};
 assert.deepEqual(weight.validateResult('credit',result,credit),result);
 assert.equal(weight.validateResult('credit',{...result,replayed:true},credit).replayed,true);
 for(const patch of[{weightIncome:-1000},{weightIncome:7001},{totalIncome:NaN},{balance:27010},{reps:8},
   {creditedAmount:7001},{sessionId:'another_12345'},{replayed:0},{amount:7000}]){
  assert.throws(()=>weight.validateResult('credit',{...result,...patch},credit),e=>e.status===503);
 }
 // Lifetime earnings survive authorized reductions of the overall total.
 assert.equal(weight.validateResult('status',{weightIncome:7000,totalIncome:2000,balance:0}).weightIncome,7000);
});
