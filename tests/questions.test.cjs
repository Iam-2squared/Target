'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {generateQuestions,loadBook}=require('../server/questions.cjs');
const input=(overrides={})=>({book:'target1900',direction:'english',count:10,from:1,to:1900,requestId:crypto.randomUUID(),...overrides});
const normalized=text=>text.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu,' ');

test('Both books and learning directions produce four distinct, source-backed choices',()=>{
  for(const book of ['target1900','target1000'])for(const direction of ['english','japanese']){
    const rows=loadBook(book);
    const questions=generateQuestions(input({book,direction,to:rows.length,count:20}));
    assert.equal(questions.length,20);
    assert.equal(new Set(questions.map(q=>q.id)).size,20);
    assert.equal(new Set(questions.map(q=>q.number)).size,20);
    for(const question of questions){
      const entry=rows[question.number-1],answerField=direction==='english'?'english':'japanese';
      assert.equal(question.prompt,entry[direction==='english'?'japanese':'english']);
      assert.equal(question.choices.length,4);
      assert.equal(new Set(question.choices.map(c=>c.id)).size,4);
      assert.equal(new Set(question.choices.map(c=>normalized(c.text))).size,4);
      assert.equal(question.correctText,entry[answerField]);
      assert.deepEqual(question.choices.filter(c=>c.id===question.correctChoiceId).map(c=>c.text),[entry[answerField]]);
      for(const choice of question.choices)assert(rows.some(row=>row[answerField]===choice.text));
    }
  }
});

test('A narrow range remains inclusive and never duplicates its final numbered entries',()=>{
  for(const [book,total] of [['target1900',1900],['target1000',1000]]){
    const result=generateQuestions(input({book,from:total-2,to:total,count:10}));
    assert.deepEqual(result.map(q=>q.number).sort((a,b)=>a-b),[total-2,total-1,total]);
  }
});

test('Duplicate Japanese translations cannot create multiple valid English choices',()=>{
  const rows=loadBook('target1000'),groups=new Map();
  for(const row of rows){const key=normalized(row.japanese);groups.set(key,[...(groups.get(key)||[]),row]);}
  const repeated=[...groups.values()].find(group=>group.length>1&&new Set(group.map(r=>normalized(r.english))).size>1);
  assert(repeated,'The real material exercises an ambiguous translation');
  for(const entry of repeated){
    const [question]=generateQuestions(input({book:'target1000',from:entry.number,to:entry.number,direction:'english'}));
    assert.equal(question.choices.filter(choice=>repeated.some(row=>normalized(row.english)===normalized(choice.text))).length,1);
  }
});

test('Unsupported modes, forged score fields and invalid material ranges are rejected',()=>{
  for(const override of [{book:'other'},{direction:'other'},{count:50},{count:0},{from:0},{to:1901},{from:5,to:4},{from:'1'},{requestId:'bad'},{correctCount:9000},{ownerId:crypto.randomUUID()}]){
    assert.throws(()=>generateQuestions(input(override)),error=>error.status===400&&error.code==='INVALID_QUIZ');
  }
});
