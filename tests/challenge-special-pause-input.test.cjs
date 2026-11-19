'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {input}=require('../server/challenge.cjs');
test('Automatic special resume accepts an original answer UUID while manual resume stays compatible',()=>{
 const manual={requestId:randomUUID(),runId:randomUUID()};
 assert.deepEqual(input('resume',manual),manual);
 const automatic={...manual,specialRequestId:randomUUID()};
 assert.deepEqual(input('resume',automatic),automatic);
 for(const specialRequestId of [null,'',false,123,'invalid'])
  assert.throws(()=>input('resume',{...manual,specialRequestId}),{code:'INVALID_CHALLENGE_REQUEST'});
});
test('Special resume authority cannot be attached to unrelated commands or extra client fields',()=>{
 const base={requestId:randomUUID(),runId:randomUUID(),specialRequestId:randomUUID()};
 for(const action of ['pause','abort'])assert.throws(()=>input(action,base),{code:'INVALID_CHALLENGE_REQUEST'});
 assert.throws(()=>input('answer',{...base,questionId:randomUUID(),choiceId:randomUUID()}),{code:'INVALID_CHALLENGE_REQUEST'});
 assert.throws(()=>input('resume',{...base,specialPausedAt:new Date().toISOString()}),{code:'INVALID_CHALLENGE_REQUEST'});
});
