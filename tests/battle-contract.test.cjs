'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const {settings,input,matchIdInUrl,BOOK_SECTIONS,HP_OPTIONS,INVITE_DEFAULTS}=require('../server/battle.cjs');
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
  const request={requestId:UUID,targetId:OPPONENT};
  assert.deepEqual(INVITE_DEFAULTS,{book:'target1900',fromSection:1,toSection:1,stake:100,initialHp:100},
    'placeholder is not a user-approved stake');
  assert.deepEqual(input('challenge',request),request);
  assert.throws(()=>input('challenge',{...request,...valid}),{code:'INVALID_BATTLE_REQUEST'},
    'invitation must have no fixed subject, stake, Section or HP');
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


test('Buzzer shares the same question, displays attack / damage stamps, and keeps four choices onscreen',()=>{
  const js=fs.readFileSync(path.join(root,'public/battle.js'),'utf8');
  const css=fs.readFileSync(path.join(root,'public/battle.css'),'utf8');
  const html=fs.readFileSync(path.join(root,'public/index.html'),'utf8');
  const server=fs.readFileSync(path.join(root,'server/battle.cjs'),'utf8');
  const store=fs.readFileSync(path.join(root,'server/store.cjs'),'utf8');
  assert.doesNotThrow(()=>new Function(js));
  for(const token of ['battleHitStamp','is-attack','is-damage','攻撃成功','被ダメージ',
    'roundCanAnswer','roundPhase','roundResult','answered','startsAt','deadlineAt','nowServer',
    "timer=setInterval(()=>{updateRoundClock();void refresh();},480)"])
    assert(js.includes(token),'buzzer script '+token);
  assert(!js.includes('自分のHP -10'),'old self-damage text is removed');
  assert(server.includes("store.buzzerRpc('next'"),'both users use one server-owned question');
  assert(server.includes("store.buzzerRpc('state'"),'state reads the shared round');
  assert(store.includes("runRpc('target_buzzer_rpc'"),'buzzer backend is private server RPC');
  assert(css.includes('grid-template-rows:repeat(4,minmax(0,1fr))'),'all answer rows fit screen');
  assert(css.includes('height:100dvh'),'game uses dynamic viewport');
  assert(css.includes('body.battle-playing #battleView>.section-heading'),'heading hidden in game');
  assert(html.includes('id="battleTitle"'),'accessible lobby heading retained');
});

test('Buzzer database migration keeps correctness and money server-owned',()=>{
  const sql=fs.readFileSync(path.join(root,'supabase/migrations/20261114094000_target_shared_buzzer_rounds.sql'),'utf8');
  for(const term of ['battle_buzzer_rounds','battle_buzzer_attempts','public.target_buzzer_rpc',
    'BATTLE_SHARED_ROUNDS_ONLY','BATTLE_ROUND_CLOSED','BATTLE_ALREADY_ANSWERED',
    'BATTLE_ROUND_NOT_STARTED','PERFORM pg_advisory_xact_lock(991101)',
    "damage_value:=5", "damage_value integer:=0","p_action='next'","p_action='answer'"])
    assert(sql.includes(term),'migration '+term);
  assert(!sql.includes('DROP TABLE target_private.profiles'));
  assert(!sql.includes('DELETE FROM target_private.two_player_wallet_events'));
});


test('Accepted invitation is the first time setup appears and battle UI has no memorization header',()=>{
  const js=fs.readFileSync(path.join(root,'public/battle.js'),'utf8');
  const css=fs.readFileSync(path.join(root,'public/battle.css'),'utf8');
  const html=fs.readFileSync(path.join(root,'public/index.html'),'utf8');
  const app=fs.readFileSync(path.join(root,'public/app.js'),'utf8');
  assert.doesNotThrow(()=>new Function(js));
  assert(js.includes("void mutate('challenge',{targetId:id})"),'invite sends only the opponent ID');
  assert(js.includes("if(!m||m.status!=='setup')"),'terms not shown before acceptance');
  assert(js.includes("if(match?.status!=='setup')"),'terms can only be proposed after acceptance');
  assert(html.includes('<h1 id="battleTitle">リアタイバトル</h1>'));
  assert(html.includes('class="view-toolbar battle-topbar"'));
  assert(css.includes('body[data-view="battle"] .app-header'),'hide unnecessary 暗記 header');
  assert(css.includes('body.battle-setup .battle-form'),'setup has a compact but readable layout');
  assert(app.includes("view==='battle'?'リアタイバトル | Target'"));
});

test('Shared buzzer restores server-owned -10 HP on wrong answers without allowing double attacks',()=>{
  const sql=fs.readFileSync(path.join(root,'supabase/migrations/20261114121000_target_buzzer_wrong_self_damage.sql'),'utf8');
  const js=fs.readFileSync(path.join(root,'public/battle.js'),'utf8');
  for(const marker of ['damage_value:=10','new_host_hp:=greatest(0,m.host_hp-',
    'new_guest_hp:=greatest(0,m.guest_hp-','PERFORM target_private.battle_settle',
    "'wrongHit'","'damage',10","IF new_host_hp=0 OR new_guest_hp=0"])
    assert(sql.includes(marker),marker);
  assert(js.includes('誤答 −10'),'red wrong-answer stamp');
  assert(js.includes("wrongHit"),'only the answering player receives their mistake feedback');
});
