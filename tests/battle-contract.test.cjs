'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const {settings,input,matchIdInUrl,BOOK_SECTIONS,HP_OPTIONS}=require('../server/battle.cjs');
const UUID='123e4567-e89b-42d3-a456-426614174000';
const OPPONENT='123e4567-e89b-42d3-a456-426614174001';
const valid={book:'target1900',fromSection:1,toSection:19,stake:100,initialHp:100};

test('Battle accepts exactly three books, their Section maxima and approved initial HPs',()=>{
  assert.deepEqual(Object.keys(BOOK_SECTIONS),['target1900','target1000','kobun400']);
  assert.deepEqual(HP_OPTIONS,[50,100,150,200,300]);
  for(const [book,max] of Object.entries(BOOK_SECTIONS)){
    assert.deepEqual(settings({...valid,book,fromSection:1,toSection:max}).book,book);
    assert.throws(()=>settings({...valid,book,toSection:max+1}),{code:'INVALID_BATTLE_REQUEST'});
  }
  for(const hp of HP_OPTIONS)assert.equal(settings({...valid,initialHp:hp}).initialHp,hp);
  for(const hp of [0,-1,60,1000,100.5])assert.throws(()=>settings({...valid,initialHp:hp}),{code:'INVALID_BATTLE_REQUEST'});
});

test('Battle stake and Section inputs fail closed on fractions, missing keys and out-of-bounds values',()=>{
  for(const stake of [0,10,99,101,150,100.1,-100,5000000000100,NaN,'100',Infinity])
    assert.throws(()=>settings({...valid,stake}),{code:'INVALID_BATTLE_REQUEST'});
  for(const stake of [100,200,10000,5000000000000])assert.equal(settings({...valid,stake}).stake,stake);
  for(const [fromSection,toSection] of [[0,1],[3,2],[1,20],[1.2,3],['1',2]])
    assert.throws(()=>settings({...valid,fromSection,toSection}),{code:'INVALID_BATTLE_REQUEST'});
  assert.throws(()=>settings({...valid,book:'secret'}),{code:'INVALID_BATTLE_REQUEST'});
  assert.throws(()=>settings(null),{code:'INVALID_BATTLE_REQUEST'});
});

test('Battle mutation contract rejects fake identities and extra client data',()=>{
  const request={requestId:UUID,targetId:OPPONENT,...valid};
  assert.deepEqual(input('challenge',request),request);
  assert.throws(()=>input('challenge',{...request,memberId:OPPONENT}),{code:'INVALID_BATTLE_REQUEST'});
  assert.throws(()=>input('challenge',{...request,correctChoiceId:UUID}),{code:'INVALID_BATTLE_REQUEST'});
  assert.throws(()=>input('challenge',{...request,requestId:'fake'}),{code:'INVALID_BATTLE_REQUEST'});
  assert.throws(()=>input('ready',{requestId:UUID,matchId:OPPONENT,expectedVersion:0}),{code:'INVALID_BATTLE_REQUEST'});
  assert.deepEqual(input('propose',{requestId:UUID,matchId:OPPONENT,expectedVersion:2,...valid}).stake,100);
  assert.deepEqual(input('answer',{requestId:UUID,matchId:OPPONENT,questionId:UUID,choiceId:OPPONENT}).choiceId,OPPONENT);
  assert.throws(()=>input('answer',{requestId:UUID,matchId:OPPONENT,questionId:UUID,choiceId:OPPONENT,correct:true}),
    {code:'INVALID_BATTLE_REQUEST'});
});

test('State query accepts the exact match ID, including Vercel internal rewrite keys',()=>{
  assert.equal(matchIdInUrl(new URL('https://target.invalid/api/battle/state?matchId='+UUID)),UUID);
  assert.equal(matchIdInUrl(new URL('https://target.invalid/api/index?route=battle/state&path=battle/state&matchId='+UUID)),UUID);
  for(const query of ['matchId=bad','matchId='+UUID+'&matchId='+UUID,
    'matchId='+UUID+'&route=ranking','matchId='+UUID+'&path=battle/lobby',
    'matchId='+UUID+'&foo=bar']){
    assert.throws(()=>matchIdInUrl(new URL('https://target.invalid/api/battle/state?'+query)),{code:'INVALID_BATTLE_REQUEST'});
  }
});

test('Study hub buttons and separate memorization Section selectors exist without old home controls',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
  const javascript=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
  for(const id of ['bookSelect','memorizeOpen','testOpen','masteryOpen','reviewOpen','battleOpen',
    'memorySetupView','memorySetupForm','memoryRangeFrom','memoryRangeTo','battleView','battleApp']){
    assert(html.includes('id="'+id+'"'),id);
  }
  assert(!html.includes('id="homeSectionFrom"'));
  assert(!html.includes('id="homeSectionTo"'));
  assert(!html.includes('id="homeMasteryLabel"'));
  assert(!javascript.includes('homeSectionFrom')&&!javascript.includes('homeSectionTo'));
  assert(fs.existsSync(path.join(__dirname,'../public/battle.js')));
  assert(fs.existsSync(path.join(__dirname,'../public/battle.css')));
});


test('Battle lobby shows logged-in self, online refresh and victory ranking independent of study points',()=>{
  const js=fs.readFileSync(path.join(root,'public/battle.js'),'utf8');
  const css=fs.readFileSync(path.join(root,'public/battle.css'),'utf8');
  assert.doesNotThrow(()=>new Function(js),'battle script parses');
  for(const token of ['ログイン中','battleLobbyRefresh','battleOnlineCount',
    'battleOnlineList','battleRankingTitle','battleRankingList','battleRankingEmpty',
    "replaceChildren(person(identity,false))","row.classList.add('is-self')",
    "entry.wins+'勝'"]){
    assert(js.includes(token),token+' is included in battle lobby');
  }
  assert(js.includes("make('span','battle-online-dot')"),'green online presence dot is rendered');
  assert(js.includes("ranking=Array.isArray(snapshot.ranking)?snapshot.ranking:[]"),
    'only server supplied ranking is displayed');
  assert(!js.includes("battleMe"),'self appears only in the member list');
  for(const token of ['.battle-online-dot','.battle-ranking-row.is-self','.battle-refresh']){
    assert(css.includes(token),token+' has styling');
  }
});
