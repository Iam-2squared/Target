'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const materials=require('../public/materials.js');
const {loadBook,generateQuestions,validateQuizInput}=require('../server/questions.cjs');
const root=path.resolve(__dirname,'..');
const uuid='123e4567-e89b-42d3-a456-426614174000';
const normalize=value=>value.normalize('NFKC').replace(/\s+/gu,'').replace(/〜/gu,'~');
const expected={
 crown:{title:'Crown',label:'Lesson',units:[
  {section:6,from:1,to:17,words:['follow','sculptor','pile','construction','quit','decide','stroll','architect','outsider','refusal','discourage','overjoyed','ordeal','acceptance','prove','chance upon 〜','turn away 〜']},
  {section:7,from:18,to:32,words:['biomimicry','mimicry','environment','survive / survival','destruction / destroy','technology / technological','innovation','inspire','architect','efficient / efficiency','challenge','solution','adapt','creature','feature']}
 ]},
 improve:{title:'Improve',label:'Section',units:[
  {section:8,from:1,to:10,words:['global','issue','solution','environment','protect','reduce','resource','recycle','affect','action']},
  {section:9,from:11,to:20,words:['influence','society','value','individual','role','contribute','community','support','active','participate']},
  {section:10,from:21,to:30,words:['future','goal','achieve','success','challenge','overcome','effort','improve','opportunity','confidence']},
  {section:11,from:31,to:42,words:['culture / cultural','tradition / traditional','custom','communicate / communication','express','understand / understanding','respect','difference','accept','connect','foreign','experience']}
 ]},
 cnn:{title:'CNN',label:'Section',units:[
  {section:1,from:1,to:24,words:['right','disconnect','employ / employee / employer','after-hours','contact','ban','penalty','balance','greenhouse gas','emission','increase / surge','artificial intelligence (AI)','data center','consume / consumption','electricity','goal / target','cancer','increase / rise','generation','young adult','factor','lifestyle','researcher / study','concern']}
 ]}
};

test('the appended materials preserve exact user unit numbers, boundaries and entry order',()=>{
 assert.deepEqual(Object.keys(materials.books),['target1900','target1000','kobun400','crown','improve','cnn']);
 const ids=new Set();
 for(const[book,spec]of Object.entries(expected)){
  const definition=materials.books[book],rows=loadBook(book);
  assert.equal(definition.title,spec.title);
  assert.equal(definition.sectionLabel,spec.label);
  assert.equal(rows.length,spec.units.at(-1).to);
  assert.equal(definition.total,rows.length);
  assert.deepEqual(materials.sectionsFor(book).map(({section,from,to})=>({section,from,to})),spec.units.map(({section,from,to})=>({section,from,to})));
  for(const unit of spec.units){
   assert.deepEqual(rows.slice(unit.from-1,unit.to).map(row=>normalize(row.english)),unit.words.map(normalize));
   assert.deepEqual(materials.wordRange(book,unit.section,unit.section),{from:unit.from,to:unit.to});
   for(const number of[unit.from,unit.to])assert.equal(materials.sectionForWord(book,number)?.section,unit.section);
   for(const row of rows.slice(unit.from-1,unit.to))assert.equal(row.section,unit.section);
  }
  for(const[rowIndex,row]of rows.entries()){
   assert.equal(row.number,rowIndex+1);
   assert.equal(row.id,definition.prefix+'-'+String(row.number).padStart(4,'0'));
   assert(!ids.has(row.id),'Distinct stable material IDs across books');ids.add(row.id);
   assert.equal(typeof row.japanese,'string');assert(row.japanese.trim());
   assert.match(row.japanese,/^[（(][名動形]/u,'Part of speech is retained in each gloss');
   assert(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/u.test(row.english+row.japanese));
  }
 }
 assert.equal(loadBook('crown').filter(row=>row.english==='architect').length,2,'Architect is intentionally retained in both lessons');
 assert.equal(new Set(loadBook('improve').map(row=>row.english)).size,42,'Repeated pasted Improve tail is not added again');
 assert.equal(loadBook('improve')[10].english,'influence','Confirmed as first word of Section9');
 assert.equal(loadBook('improve')[29].english,'confidence');
 assert.equal(loadBook('improve')[30].english,'culture / cultural');
});

test('custom unit ranges reject nonexistent numbers without coercing lessons to 100-word sections',()=>{
 for(const[book,bad]of[['crown',[0,1,2,5,8]],['improve',[0,1,7,12]],['cnn',[0,2,8]]]){
  const sections=materials.sectionsFor(book);
  assert.deepEqual(materials.wordRange(book,sections[0].section,sections.at(-1).section),{from:1,to:materials.books[book].total});
  for(const section of bad)assert.equal(materials.wordRange(book,section,section),null);
  if(sections.length>1)assert.equal(materials.wordRange(book,sections.at(-1).section,sections[0].section),null);
  assert.equal(materials.sectionForWord(book,0),null);
  assert.equal(materials.sectionForWord(book,materials.books[book].total+1),null);
 }
 assert.deepEqual(materials.sectionsFor('invalid'),[]);
 for(const[book,total,count]of[['target1900',1900,19],['target1000',1000,10],['kobun400',400,4]]){
  const sections=materials.sectionsFor(book);
  assert.equal(sections.length,count);
  assert.deepEqual(materials.wordRange(book,1,count),{from:1,to:total});
  for(const[ordinal,section]of sections.entries())assert.deepEqual({section:section.section,from:section.from,to:section.to},{section:ordinal+1,from:ordinal*100+1,to:(ordinal+1)*100});
 }
});

test('normal and review quizzes accept every new unit and generate unique, unambiguous choices',()=>{
 for(const[book,spec]of Object.entries(expected))for(const unit of spec.units)for(const direction of['english','japanese']){
  const input={book,direction,count:100,from:unit.from,to:unit.to,requestId:uuid};
  assert.deepEqual(validateQuizInput(input),input);
  const rows=loadBook(book),questions=generateQuestions(input);
  assert.equal(questions.length,unit.to-unit.from+1);
  assert.deepEqual(questions.map(row=>row.number).sort((a,b)=>a-b),Array.from({length:unit.to-unit.from+1},(_,i)=>unit.from+i));
  for(const question of questions){
   const source=rows[question.number-1];
   assert.equal(question.prompt,source[direction==='english'?'japanese':'english']);
   assert.equal(question.correctText,source[direction]);
   assert.equal(question.choices.length,4);
   assert.equal(new Set(question.choices.map(choice=>normalize(choice.text))).size,4);
   assert.equal(question.choices.filter(choice=>choice.id===question.correctChoiceId).length,1);
   assert.equal(question.choices.find(choice=>choice.id===question.correctChoiceId).text,source[direction]);
  }
  const review=generateQuestions(input,[unit.from,unit.to]);
  assert.deepEqual(review.map(row=>row.number).sort((a,b)=>a-b),[unit.from,unit.to]);
  assert.throws(()=>generateQuestions(input,[unit.from-1]),{code:'REVIEW_UNAVAILABLE'});
 }
});

test('new normal-study materials do not silently change battle/challenge pools or legacy badge exports',()=>{
 const {BOOK_SECTIONS}=require('../server/battle.cjs');
 assert.deepEqual(Object.keys(BOOK_SECTIONS),['target1900','target1000','kobun400']);
 const badge=require('../server/badges.cjs');
 assert.equal(badge.BADGES.size,37);
 assert(![...badge.BADGES].some(id=>id.includes('crown')||id.includes('improve')||id.includes('cnn')));
 for(const book of['crown','improve','cnn'])assert(fs.existsSync(path.join(root,'data',book+'.json')));
});
