'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const gate=require('../public/reward-lock.js');

test('reward-lock states validate strictly while historical missing fields remain compatible',()=>{
  assert.equal(gate.parse(undefined),null);
  assert.deepEqual(gate.parse(gate.initial()),{locked:false,missStreak:0,recoveryStreak:0});
  for(const value of [null,[],{},false,{locked:false,missStreak:2,recoveryStreak:0},{locked:false,missStreak:0,recoveryStreak:1},{locked:true,missStreak:0,recoveryStreak:0},{locked:true,missStreak:1,recoveryStreak:2},{locked:true,missStreak:2,recoveryStreak:3},{locked:true,missStreak:-1,recoveryStreak:0},{locked:'yes',missStreak:0,recoveryStreak:0},{...gate.initial(),unknown:1}])assert.throws(()=>gate.parse(value));
});

test('two consecutive misses stop rewards until three consecutive unpaid correct answers complete',()=>{
  let state=gate.initial();
  const advance=correct=>{const next=gate.transition(state,correct);state=next.state;return next;};
  assert.equal(advance(false).state.locked,false);
  assert.equal(advance(true).canAward,true,'A correct answer breaks a single miss streak');
  advance(false);assert.equal(advance(false).state.locked,true);
  assert.equal(advance(true).canAward,false);assert.equal(state.recoveryStreak,1);
  assert.equal(advance(true).canAward,false);assert.equal(state.recoveryStreak,2);
  advance(false);assert.equal(state.recoveryStreak,0,'One recovery miss restarts the consecutive-correct requirement');
  assert.equal(advance(true).canAward,false);
  assert.equal(advance(true).canAward,false);
  const unlock=advance(true);assert.equal(unlock.canAward,false);assert.equal(unlock.resumed,true);assert.deepEqual(state,gate.initial());
  assert.equal(advance(true).canAward,true,'The following answer may earn again');
});

test('every short answer sequence follows consecutive streak policy without mutating prior confirmed snapshots',()=>{
  for(let sequence=0;sequence<1024;sequence++){
    let state=gate.initial(),misses=0,recovery=0,locked=false;
    for(let i=0;i<10;i++){
      const correct=!!(sequence&(1<<i)),prior={...state},wasLocked=locked;
      const next=gate.transition(state,correct);
      assert.deepEqual(state,prior,'Confirmed states are not mutated by later answers');
      if(locked){recovery=correct?recovery+1:0;if(recovery===3){locked=false;misses=0;recovery=0;}}
      else{misses=correct?0:misses+1;if(misses===2)locked=true;}
      assert.equal(next.state.locked,locked);assert.equal(next.canAward,correct&&!wasLocked);
      assert.equal(next.state.recoveryStreak,locked?recovery:0);state=next.state;
    }
  }
});

test('recovery notice explains zero awards and clears after the unlocking answer',()=>{
  assert.equal(gate.notice(gate.initial()),'');
  assert.match(gate.notice({locked:true,missStreak:2,recoveryStreak:2}),/加点停止中.*2\/3/);
  assert.match(gate.notice(gate.initial(),true),/次の問題から加点/);
});
