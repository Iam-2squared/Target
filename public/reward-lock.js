'use strict';
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;else root.TargetRewardLock=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  const initial=()=>({locked:false,missStreak:0,recoveryStreak:0});
  function parse(value){
    if(value===undefined)return null;
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==3||
      !['locked','missStreak','recoveryStreak'].every(key=>Object.hasOwn(value,key))||typeof value.locked!=='boolean'||
      !Number.isInteger(value.missStreak)||value.missStreak<0||value.missStreak>2||
      !Number.isInteger(value.recoveryStreak)||value.recoveryStreak<0||value.recoveryStreak>2||
      value.locked&&value.missStreak!==2||!value.locked&&(value.missStreak===2||value.recoveryStreak!==0))throw Error('加点状態を確認できませんでした。同じ回答を再送してください。');
    return {locked:value.locked,missStreak:value.missStreak,recoveryStreak:value.recoveryStreak};
  }
  function transition(value,correct){
    const state=parse(value);if(!state||typeof correct!=='boolean')throw Error('Invalid reward-lock transition');
    if(state.locked){
      const recovery=correct?state.recoveryStreak+1:0,resumed=recovery===3;
      return {state:resumed?initial():{locked:true,missStreak:2,recoveryStreak:recovery},canAward:false,resumed};
    }
    const misses=correct?0:state.missStreak+1;
    return {state:{locked:misses===2,missStreak:misses,recoveryStreak:0},canAward:correct,resumed:false};
  }
  function notice(value,resumed=false){
    const state=parse(value);
    return resumed?'3回連続正解！次の問題から加点します。':state?.locked?'加点停止中：3回連続正解で解除（'+state.recoveryStreak+'/3）':'';
  }
  return Object.freeze({initial,parse,transition,notice});
});
