'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const books = {
    target1900: {title:'Target 1900',kind:'英単語',total:1900,wordLabel:'英語',meaningLabel:'訳'},
    target1000: {title:'英熟語Target 1000',kind:'英熟語',total:1000,wordLabel:'英語',meaningLabel:'訳'},
    kobun400: {title:'古文単語',kind:'古文単語',total:400,wordLabel:'古語',meaningLabel:'現代語訳'}
  };
  const views = ['home','memorize','setup','quiz','result','ranking','mastery'];
  const datasets = new Map(), datasetPromises = new Map();
  let selectedBook='target1900', activeView='home', member=null, lifetimeCorrect=0, lifetimePoints=0;
  let sessionKnown=false, sessionEpoch=0, sessionTicket=0, walletBalance=0, walletKnown=false;
  const rankingTickets={homeRanking:0,ranking:0};
  const sectionRanges={target1900:{from:1,to:1},target1000:{from:1,to:1},kobun400:{from:1,to:1}};
  let masteryTicket=0,homeReviewTicket=0,setupMode='normal';
  let memoryPage=0, memoryBook='target1900', meaningsHidden=false, memoryTicket=0;
  let memoryPages=[], memoryColumnWidths=[], memoryLayoutKey='', memoryLayoutFrame=0,memorySelectionKey='',memoryRange={from:1,to:100};
  let quiz=null, startRetry=null, starting=false, loginPending=false, logoutPending=false;
  const SOUND_KEY='target-sound-enabled';
  let soundEnabled=readSoundSetting(),soundPlayers,soundGeneration=0,activeSound=null,soundSessionLease=null;
  let toastTimer, resultTimer, resultGeneration=0, resultDisplay=null, resultPointer=null, lastAdvanceTap=null;
  const bonus=window.TargetBonusTime.create({session:()=>sessionEpoch,soundEnabled:()=>soundEnabled,
    claimAudioSession:claimSoundSession,releaseAudioSession:releaseSoundSession,onPlaybackStart:stopSound,
    onForeground:()=>{if(member)void refreshSession({notify:false});}});

  function element(tag,className,text) {
    const node=document.createElement(tag);
    if(className)node.className=className;
    if(text!==undefined)node.textContent=String(text);
    return node;
  }
  function uuid() {
    if(typeof crypto.randomUUID==='function')return crypto.randomUUID();
    const values=crypto.getRandomValues(new Uint8Array(16));
    values[6]=(values[6]&15)|64;values[8]=(values[8]&63)|128;
    const hex=Array.from(values,value=>value.toString(16).padStart(2,'0')).join('');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  }
  const normalize=value=>value.normalize('NFKC').toLocaleLowerCase('en').replace(/\s+/g,' ').trim();
  function shuffle(items) {
    const result=items.slice();
    for(let i=result.length-1;i>0;i--){const value=crypto.getRandomValues(new Uint32Array(1))[0],j=value%(i+1);[result[i],result[j]]=[result[j],result[i]];}
    return result;
  }
  const validPoints=value=>Number.isSafeInteger(value)&&value>=0;
  const gou=value=>value.toLocaleString('ja-JP')+'轟';
  function guestAward() {
    const limit=0x100000000-(0x100000000%100);let value;
    do {value=crypto.getRandomValues(new Uint32Array(1))[0];} while(value>=limit);
    const roll=value%100;return roll===0?100000:roll<=2?10000:roll<=17?1000:100;
  }
  function hideRewardVisual() {
    window.TargetJackpotEffects?.hide();
    $('rewardCelebration').hidden=true;
  }
  function cancelResultAdvance() {
    clearTimeout(resultTimer);resultTimer=undefined;resultGeneration++;
    resultDisplay=null;resultPointer=null;$('quizAdvanceSurface').hidden=true;
  }
  function confirmedResult(current=quiz) {
    return !!current&&quiz===current&&current.feedback&&current.sessionEpoch===sessionEpoch&&
      activeView==='quiz'&&!document.hidden&&!document.querySelector('dialog[open]');
  }
  function liveResultDisplay(display) {
    return !!display&&resultDisplay===display&&display.generation===resultGeneration&&
      confirmedResult(display.quiz)&&display.quiz.question.id===display.questionId&&display.epoch===sessionEpoch;
  }
  function pauseResultDisplay() {cancelResultAdvance();hideRewardVisual();stopSound();}
  function clearRewardCelebration() {
    pauseResultDisplay();delete $('rewardCelebration').dataset.tier;
    $('rewardCelebration').style.removeProperty('--reward-duration');
    $('rewardCelebration').classList.remove('reward-restored');
    $('feedbackReward').replaceChildren();$('feedbackReward').hidden=true;$('rewardAnnouncement').textContent='';
  }
  function celebrateReward(current,amount) {
    if(!amount||!confirmedResult(current))return;
    const restored=current.rewardCelebratedQuestionId===current.question.id;
    current.rewardCelebratedQuestionId=current.question.id;
    const amountNode=$('feedbackReward'),overlay=$('rewardCelebration');
    amountNode.replaceChildren(element('span','reward-sign','+'),element('span','reward-number',amount.toLocaleString('ja-JP')),element('span','reward-unit','轟'));
    overlay.dataset.tier=amount===100000?'grand':amount===10000?'jackpot':amount===1000?'bonus':amount===500?'bonus-time':'standard';
    overlay.style.setProperty('--reward-duration','1000ms');overlay.classList.toggle('reward-restored',restored);
    amountNode.hidden=false;overlay.hidden=false;
    if(amount===10000||amount===100000)window.TargetJackpotEffects?.show({restored});else window.TargetJackpotEffects?.hide();
    $('rewardAnnouncement').textContent='+'+gou(amount);
  }
  function beginResultDisplay(current=quiz) {
    cancelResultAdvance();
    if(!confirmedResult(current))return;
    if(current.feedback.awardPoints)celebrateReward(current,current.feedback.awardPoints);else hideRewardVisual();
    const surface=$('quizAdvanceSurface');
    surface.setAttribute('aria-label',current.finished?'テスト結果を見る':'次の問題へ');surface.hidden=false;
    const display={quiz:current,questionId:current.question.id,epoch:sessionEpoch,generation:resultGeneration,deadline:performance.now()+1000};
    resultDisplay=display;
    resultTimer=setTimeout(()=>{resultTimer=undefined;if(liveResultDisplay(display))nextQuestion(display);},1000);
  }
  function releaseResultPointer(event) {
    const held=resultPointer;if(!held||event.pointerId!==held.id)return;
    resultPointer=null;
    if(!liveResultDisplay(held.display))return;
    // Keep the old result surface through the native release/click sequence.
    // A held gesture cannot cross the timeout and land on a new answer button.
    clearTimeout(resultTimer);
    resultTimer=setTimeout(()=>{resultTimer=undefined;if(liveResultDisplay(held.display))nextQuestion(held.display);},Math.max(80,held.display.deadline-performance.now()));
  }
  function advanceByTap(event) {
    event.preventDefault();event.stopPropagation();
    if(!liveResultDisplay(resultDisplay))return;
    bonus.gesture();
    const tap=event.detail>0?{at:performance.now(),x:event.clientX,y:event.clientY}:null;
    if(nextQuestion(resultDisplay)&&tap)lastAdvanceTap=tap;
  }
  function repeatsAdvanceTap(event) {
    return event.detail>0&&lastAdvanceTap&&performance.now()-lastAdvanceTap.at<300&&
      Math.hypot(event.clientX-lastAdvanceTap.x,event.clientY-lastAdvanceTap.y)<24;
  }
  function readSoundSetting() {
    try{return localStorage.getItem(SOUND_KEY)!=='false';}catch{return true;}
  }
  function releaseSoundSession(token) {
    if(!token||token.released)return;token.released=true;
    const lease=token.lease;if(soundSessionLease!==lease)return;
    lease.users--;if(lease.users>0)return;
    soundSessionLease=null;
    try{if(lease.owned&&lease.session.type==='playback')lease.session.type=lease.previous;}catch{}
  }
  function claimSoundSession() {
    try{
      if(soundSessionLease){soundSessionLease.users++;return {lease:soundSessionLease,released:false};}
      const session=navigator.audioSession;
      if(!session||typeof session.type!=='string')return null;
      const previous=session.type;
      if(previous!=='playback')session.type='playback';
      soundSessionLease={session,previous,owned:previous!=='playback'&&session.type==='playback',users:1};
      return {lease:soundSessionLease,released:false};
    }catch{return null;}
  }
  function prepareSound() {
    if(!soundEnabled)return null;
    if(soundPlayers)return soundPlayers;
    try{
      if(typeof window.Audio!=='function')return null;
      const players={correct:new Audio('/audio/correct.mp3'),wrong:new Audio('/audio/wrong.mp3')};
      for(const player of Object.values(players)){player.preload='auto';player.volume=.85;player.loop=false;player.load();}
      soundPlayers=players;return players;
    }catch{return null;}
  }
  function stopSound() {
    soundGeneration++;
    const previous=activeSound;activeSound=null;
    if(previous)for(const [event,handler] of previous.listeners)previous.player.removeEventListener(event,handler);
    if(soundPlayers)for(const player of Object.values(soundPlayers)){try{player.pause();player.currentTime=0;}catch{}}
    releaseSoundSession(previous?.lease);
  }
  function playSoundCue(kind,current=null) {
    if(!soundEnabled||document.hidden)return;
    if(current&&(quiz!==current||current.sessionEpoch!==sessionEpoch||activeView!=='quiz'))return;
    const players=prepareSound();if(!players)return;
    stopSound();
    const player=players[kind],token=soundGeneration,questionId=current?.question.id,epoch=sessionEpoch;
    const lease=claimSoundSession();
    const finish=event=>{
      if(activeSound?.token!==token||activeSound.player!==player)return;
      if(event?.type==='ended'&&!player.ended)return;
      if(event?.type==='pause'&&!player.paused)return;
      for(const [name,handler] of activeSound.listeners)player.removeEventListener(name,handler);
      activeSound=null;releaseSoundSession(lease);
    };
    const listeners=[['ended',finish],['error',finish],['pause',finish]];
    activeSound={player,token,listeners,lease};for(const [name,handler] of listeners)player.addEventListener(name,handler);
    try{
      if(player.error)player.load();
      player.muted=false;player.volume=.85;player.currentTime=0;
      // Keep play() itself in the answer/settings user gesture, not a resume()
      // promise chain. Loading or blocked audio never holds grading or timers.
      const playing=player.play();
      void Promise.resolve(playing).then(()=>{
        if(activeSound?.token!==token){if(activeSound?.player!==player)try{player.pause();}catch{}return;}
        if(!soundEnabled||document.hidden||epoch!==sessionEpoch||(current&&(quiz!==current||current.question.id!==questionId||activeView!=='quiz')))stopSound();
      },()=>finish());
    }catch{finish();}
  }
  function feedbackSound(current,correct) {
    if(current.soundPlayed)return;current.soundPlayed=true;
    if(bonus.active())return;
    playSoundCue(correct?'correct':'wrong',current);
  }
  function setSoundEnabled(enabled,{preview=false,persist=true}={}) {
    soundEnabled=enabled;$('soundSetting').value=enabled?'on':'off';
    if(persist)try{localStorage.setItem(SOUND_KEY,String(enabled));}catch{}
    bonus.setSoundEnabled(enabled);
    if(!enabled)stopSound();else if(bonus.active())bonus.gesture();else if(preview)playSoundCue('correct');
  }
  window.addEventListener('storage',event=>{if(event.key===SOUND_KEY)setSoundEnabled(event.newValue!=='false',{persist:false});});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)pauseResultDisplay();else if(confirmedResult())beginResultDisplay();});
  function setError(id,message='') {const node=$(id);node.textContent=message;node.hidden=!message;}
  function toast(message) {clearTimeout(toastTimer);$('toast').textContent=message;$('toast').hidden=false;toastTimer=setTimeout(()=>{$('toast').hidden=true;},3500);}
  function show(view,{scroll=true}={}) {
    if(view!=='quiz')clearRewardCelebration();
    activeView=view;
    document.body.dataset.view=view;
    for(const id of views)$(id+'View').hidden=id!==view;
    if(scroll)window.scrollTo({top:0,behavior:'instant'});
    document.title=['home','memorize'].includes(view)?'暗記':({memorize:'暗記',setup:setupMode==='review'?'解き直し':'テスト',quiz:'テスト',result:'テスト結果',ranking:'ランキング',mastery:'定着率'}[view]+' | 暗記');
  }
  function home() {memoryTicket++;clearMastery();show('home');renderIdentity();renderSectionControls();void loadHomeReview();void loadRanking('homeRanking');}
  function goHome() {if(activeView==='quiz'&&quiz&&!quiz.finished){openQuit();return;}home();}
  function appError(message,code='',status=0) {const error=new Error(message);error.code=code;error.status=status;return error;}
  async function api(path,body) {
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),20000);
    const requestStartedAtMs=performance.now();
    try {
      const response=await fetch('/api'+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',redirect:'error',headers:body===undefined?{'Accept':'application/json'}:{'Content-Type':'application/json','Accept':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal});
      let data;try{data=await response.json();}catch{throw appError('サーバーの応答を読み込めませんでした。もう一度お試しください。');}
      if(!response.ok){const details=data?.error;throw appError(typeof details?.message==='string'?details.message:'接続に失敗しました。もう一度お試しください。',typeof details?.code==='string'?details.code:'',response.status);}
      if(!data||typeof data!=='object'||Array.isArray(data))throw appError('サーバーの応答を確認できませんでした。');
      const supplied=Number(response.headers.get('X-Target-Now'));
      const processingHeader=response.headers.get('X-Target-Processing-Ms'),processing=processingHeader===null?undefined:Number(processingHeader);
      Object.defineProperty(data,'__timing',{value:{serverNowMs:Number.isFinite(supplied)&&supplied>0?supplied:Date.now(),serverProcessingMs:Number.isFinite(processing)&&processing>=0?processing:undefined,requestStartedAtMs,receivedAtMs:performance.now()}});
      return data;
    } catch(error) {
      if(error?.name==='AbortError')throw appError('通信に時間がかかっています。入力はそのままで、もう一度お試しください。');
      if(error instanceof TypeError)throw appError('接続できませんでした。通信状態を確認して、もう一度お試しください。');
      throw error;
    } finally {clearTimeout(timeout);}
  }
  function checkedBonus(value){
    if(value===undefined||value===null)return null;
    const started=typeof value.startedAt==='string'?Date.parse(value.startedAt):NaN,ends=typeof value.endsAt==='string'?Date.parse(value.endsAt):NaN;
    if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.id)||value.durationMs!==15900||!Number.isFinite(started)||!Number.isFinite(ends)||ends-started!==15900)throw appError('ボーナスタイムの情報を確認できませんでした。同じ操作を再試行してください。');
    return {id:value.id,startedAt:value.startedAt,endsAt:value.endsAt,durationMs:15900};
  }
  function parseIdentity(data) {
    if(data.member!==null&&(!data.member||typeof data.member!=='object'||typeof data.member.name!=='string'||data.member.name.length>20))throw appError('アカウントの情報を確認できませんでした。');
    if(!Number.isSafeInteger(data.correctCount)||data.correctCount<0||!validPoints(data.totalPoints)||!validPoints(data.balance)||!validPoints(data.totalIncome)||!validPoints(data.spent)||data.totalIncome!==data.totalPoints||data.balance+data.spent!==data.totalIncome)throw appError('保有金額を確認できませんでした。');
    return {member:data.member===null?null:{name:data.member.name},correctCount:data.correctCount,totalPoints:data.totalPoints,balance:data.balance,bonus:checkedBonus(data.bonus),timing:data.__timing};
  }
  function renderIdentity() {
    $('accountBadge').textContent=member?(member.name.trim()||'KGSアカウント'):(sessionKnown?'ゲスト':'接続未確認');
    $('homeScore').textContent=member?gou(lifetimePoints):'';
    $('loggedInSettings').hidden=!member;$('loginForm').hidden=!!member;
    $('identityName').textContent=member?.name||'';$('identityInitial').textContent=member?.name?.trim()?.slice(0,1)||'K';
    $('settingsBalance').textContent=walletKnown?gou(walletBalance):'—';$('settingsScore').textContent=walletKnown?gou(lifetimePoints):'—';$('soundSetting').value=soundEnabled?'on':'off';
    $('testMode').textContent=member?'ランキングに記録':'ゲスト（記録なし）';
    $('testStart').textContent=starting?'準備中…':'開始';
    $('testStart').disabled=starting||(setupMode==='review'&&!member);
    $('reviewNotice').hidden=setupMode!=='review';$('reviewLogin').hidden=setupMode!=='review'||!!member;
    $('reviewNotice').textContent=member?'間違えた後、まだ定着していない単語を出題します。':'解き直しにはログインが必要です。';
    $('masteryLogin').hidden=!!member;
    if(!member){$('homeReviewCount').textContent='—';$('homeReviewStatus').textContent=sessionKnown?'ログインして確認':'接続を確認しています…';$('homeReviewRetry').hidden=true;}
  }
  async function refreshSession({notify=true,walletFeedback=false}={}) {
    const ticket=++sessionTicket,epoch=sessionEpoch;
    try {
      const identity=parseIdentity(await api('/session'));
      if(ticket!==sessionTicket||epoch!==sessionEpoch)return;
      const changed=!!member!==!!identity.member;
      if(changed)bonus.reset();
      // The session cookie may have changed in another tab even when both
      // identities are logged in. Never retain one account's rendered mastery
      // through a fresh server session check or apply its outstanding request.
      clearMastery();
      member=identity.member;lifetimeCorrect=identity.correctCount;lifetimePoints=identity.totalPoints;walletBalance=identity.balance;walletKnown=!!member;sessionKnown=true;
      if(member)bonus.update(identity.bonus,identity.timing);
      $('connectionNotice').hidden=true;renderIdentity();
      if(activeView==='mastery')void loadMastery();
      if(activeView==='home')void loadHomeReview();
    } catch(error) {
      if(ticket!==sessionTicket||epoch!==sessionEpoch)return;
      if(error.status===401){bonus.reset();clearMastery();member=null;lifetimeCorrect=0;lifetimePoints=0;walletBalance=0;walletKnown=false;sessionKnown=true;}
      if(walletFeedback){walletKnown=false;if($('settingsDialog').open)setError('settingsError','保有金額を確認できませんでした。もう一度個人設定を開いてください。');}
      if(notify){$('connectionNotice').textContent='共有機能に接続できません。暗記とゲスト練習は利用できます。';$('connectionNotice').hidden=false;}
      renderIdentity();
    }
  }
  async function dataset(book) {
    if(datasets.has(book))return datasets.get(book);
    if(datasetPromises.has(book))return datasetPromises.get(book);
    const promise=(async()=>{
      let response;
      try{response=await fetch('/data/'+book+'.json',{cache:'default',redirect:'error'});}catch{throw appError('教材を読み込めませんでした。通信状態を確認して、もう一度お試しください。');}
      if(!response.ok)throw appError('教材を読み込めませんでした。もう一度お試しください。');
      let rows;try{rows=await response.json();}catch{throw appError('教材の形式を確認できませんでした。');}
      if(!Array.isArray(rows)||rows.length!==books[book].total||new Set(rows.map(row=>row?.id)).size!==rows.length||rows.some((row,index)=>!row||row.number!==index+1||typeof row.id!=='string'||typeof row.english!=='string'||!row.english.trim()||typeof row.japanese!=='string'||!row.japanese.trim()))throw appError('教材の内容を確認できませんでした。');
      datasets.set(book,rows);return rows;
    })();
    datasetPromises.set(book,promise);
    try{return await promise;}finally{datasetPromises.delete(book);}
  }
  function selectBook(book) {
    if(!Object.hasOwn(books,book))return;selectedBook=book;
    $('bookSelect').value=book;
    clearMastery();startRetry=null;renderSectionControls();
    if(activeView==='home')void loadHomeReview();
  }
  function selectedWordRange(book=selectedBook){
    const range=sectionRanges[book];return {from:(range.from-1)*100+1,to:Math.min(range.to*100,books[book].total)};
  }
  function renderSectionControls(){
    const total=Math.ceil(books[selectedBook].total/100),range=sectionRanges[selectedBook];
    $('bookSelect').value=selectedBook;
    $('directionWordLabel').textContent=books[selectedBook].wordLabel;
    $('directionMeaningLabel').textContent=books[selectedBook].meaningLabel;
    for(const [id,part] of [['homeSectionFrom','from'],['homeSectionTo','to'],['rangeFrom','from'],['rangeTo','to']]){
      const select=$(id);
      if(select.options.length!==total){const fragment=document.createDocumentFragment();for(let number=1;number<=total;number++){const option=element('option','', 'Section '+number);option.value=String(number);fragment.append(option);}select.replaceChildren(fragment);}
      select.value=String(range[part]);
    }
    const review=setupMode==='review';$('testSectionRange').hidden=review;
    $('rangeFrom').disabled=review;$('rangeTo').disabled=review;
  }
  function changeSection(part,value){
    const section=Number(value),total=Math.ceil(books[selectedBook].total/100);if(!Number.isInteger(section)||section<1||section>total)return;
    const range=sectionRanges[selectedBook];range[part]=section;
    if(range.from>range.to)range[part==='from'?'to':'from']=section;
    startRetry=null;renderSectionControls();
  }
  function clearMastery(){
    homeReviewTicket++;$('homeReviewCount').textContent='—';$('homeReviewStatus').textContent='';$('homeReviewRetry').hidden=true;$('homeReviewRetry').disabled=false;
    masteryTicket++;$('masteryList').replaceChildren();$('masteryStatus').textContent='';setError('masteryError');
    $('masteryRefresh').disabled=false;
  }
  function openMastery(){
    clearMastery();$('masteryBook').textContent=books[selectedBook].title;show('mastery');void loadMastery();
  }
  function masteryRows(data,book){
    const total=books[book].total,sectionCount=Math.ceil(total/100);
    if(data.book!==book||!Array.isArray(data.sections)||data.sections.length!==sectionCount||!Array.isArray(data.reviewNumbers)||data.reviewNumbers.length>total||data.reviewNumbers.some((number,index)=>!Number.isSafeInteger(number)||number<1||number>total||(index>0&&number<=data.reviewNumbers[index-1])))throw appError('定着率の内容を確認できませんでした。もう一度お試しください。');
    for(let index=0;index<sectionCount;index++){
      const row=data.sections[index],from=index*100+1,to=Math.min(from+99,total),size=to-from+1;
      if(!row||row.section!==index+1||row.from!==from||row.to!==to||row.total!==size||!Number.isSafeInteger(row.mastered)||row.mastered<0||row.mastered>size||row.percent!==Math.floor(row.mastered*100/size)||!Number.isSafeInteger(row.reviewCount)||row.reviewCount<0||row.reviewCount>size-row.mastered||row.reviewCount!==data.reviewNumbers.filter(number=>number>=from&&number<=to).length)throw appError('定着率の内容を確認できませんでした。もう一度お試しください。');
    }
    return data.sections;
  }
  async function loadHomeReview(){
    const ticket=++homeReviewTicket,epoch=sessionEpoch,book=selectedBook;
    const current=()=>ticket===homeReviewTicket&&epoch===sessionEpoch&&activeView==='home'&&book===selectedBook;
    $('homeReviewCount').textContent='—';$('homeReviewRetry').hidden=true;
    if(!member){renderIdentity();return;}
    $('homeReviewStatus').textContent='読み込み中…';$('homeReviewRetry').disabled=true;
    try{
      const data=await api('/mastery?book='+encodeURIComponent(book));if(!current())return;
      masteryRows(data,book);$('homeReviewCount').textContent=data.reviewNumbers.length+'個';$('homeReviewStatus').textContent='';
    }catch(error){
      if(!current())return;
      if(error.status===401){bonus.reset();clearMastery();member=null;lifetimeCorrect=0;lifetimePoints=0;walletBalance=0;walletKnown=false;sessionKnown=true;sessionEpoch++;sessionTicket++;renderIdentity();}
      else{$('homeReviewStatus').textContent='読み込めませんでした。';$('homeReviewRetry').hidden=false;}
    }finally{if(current())$('homeReviewRetry').disabled=false;}
  }
  async function loadMastery(){
    const ticket=++masteryTicket,epoch=sessionEpoch,book=selectedBook;
    const current=()=>ticket===masteryTicket&&epoch===sessionEpoch&&activeView==='mastery'&&book===selectedBook;
    $('masteryBook').textContent=books[book].title;$('masteryList').replaceChildren();setError('masteryError');
    $('masteryLogin').hidden=!!member;$('masteryRefresh').disabled=false;
    if(!member){$('masteryStatus').textContent='ログインして定着率を確認できます。';return;}
    $('masteryStatus').textContent='読み込み中…';$('masteryRefresh').disabled=true;
    try{
      const data=await api('/mastery?book='+encodeURIComponent(book));if(!current())return;
      const fragment=document.createDocumentFragment();
      for(const row of masteryRows(data,book)){
        const item=element('li','mastery-row'),heading=element('div','mastery-row-heading'),progress=element('progress');
        item.dataset.section=String(row.section);heading.append(element('strong','mastery-section','Section '+row.section),element('span','mastery-percent',row.percent+'%'));
        progress.max=row.total;progress.value=row.mastered;progress.setAttribute('aria-label','Section '+row.section+'の定着率 '+row.percent+'%');
        item.append(heading,element('span','mastery-count',row.mastered+' / '+row.total),progress);fragment.append(item);
      }
      $('masteryList').replaceChildren(fragment);$('masteryStatus').textContent='2回連続で正解すると定着します。';
    }catch(error){
      if(!current())return;
      if(error.status===401){bonus.reset();clearMastery();member=null;lifetimeCorrect=0;lifetimePoints=0;walletBalance=0;walletKnown=false;sessionKnown=true;sessionEpoch++;sessionTicket++;renderIdentity();$('masteryStatus').textContent='ログインして定着率を確認できます。';}
      else{$('masteryStatus').textContent='';setError('masteryError',error.message);}
    }finally{if(current())$('masteryRefresh').disabled=false;}
  }
  async function openMemory() {
    const book=selectedBook,ticket=++memoryTicket,range=selectedWordRange(book),key=book+':'+range.from+':'+range.to;
    if(memorySelectionKey!==key){memoryPage=0;memoryPages=[];memoryLayoutKey='';}memoryBook=book;memoryRange=range;memorySelectionKey=key;
    $('memorySheet').classList.toggle('is-vertical',book==='kobun400');
    $('memorySheet').replaceChildren(element('p','memory-loading','読み込み中…'));
    $('memorizeBook').textContent=books[book].title;setError('memorizeError');show('memorize');
    $('memoryNext').disabled=true;$('memoryPrevious').disabled=true;
    try{await dataset(book);if(ticket===memoryTicket&&activeView==='memorize')renderMemory();}
    catch(error){if(ticket!==memoryTicket)return;setError('memorizeError',error.message);$('memorySheet').replaceChildren();$('memoryNext').disabled=false;$('memoryNext').textContent='再読み込み';}
  }
  function memoryRow(row,columnWidth) {
    const line=element('div','memory-row'),copy=element('div','memory-copy'),word=element('div','memory-word');
    if(columnWidth!==undefined)line.style.width=columnWidth+'px';
    word.append(element('span','word-number',row.number),element('span','memory-english',row.english));
    copy.append(word,element('div','memory-meaning',row.japanese));
    line.append(copy);return line;
  }
  function planMemoryPages(rows) {
    const sheet=$('memorySheet'),width=sheet.clientWidth,height=sheet.clientHeight,vertical=memoryBook==='kobun400';
    if(!width||!height)return false;
    const key=memorySelectionKey+':'+width+':'+height;
    if(key===memoryLayoutKey&&memoryPages.length)return true;
    const anchor=memoryPages[memoryPage]?.start??0,wasLast=memoryPages.length>0&&memoryPage===memoryPages.length-1;
    const measure=element('div','memory-measure'),fragment=document.createDocumentFragment();
    measure.setAttribute('aria-hidden','true');measure.inert=true;
    // A definite height prevents WebKit from overestimating vertical text widths.
    if(vertical)measure.style.height=sheet.getBoundingClientRect().height+'px';
    for(const row of rows)fragment.append(memoryRow(row));
    measure.append(fragment);sheet.replaceChildren(measure);
    // Classical Japanese fills top-to-bottom columns from right to left.
    // Measure along the page's packing axis so both layouts fit the viewport.
    const sizes=Array.from(measure.children,node=>Math.ceil(node.getBoundingClientRect()[vertical?'width':'height']));
    const capacity=Math.max(1,(vertical?width:height)-5),pages=[];
    let start=0,used=0,count=0;
    for(let index=0;index<sizes.length;index++){
      if(count&&used+sizes[index]>capacity){
        pages.push({start,end:index});start=index;used=0;count=0;
      }
      used+=sizes[index];count++;
    }
    if(count)pages.push({start,end:rows.length});
    // Reuse column widths so WebKit keeps wrapped meanings inside their entry.
    memoryPages=pages;memoryColumnWidths=vertical?sizes:[];memoryLayoutKey=key;
    memoryPage=wasLast?pages.length-1:Math.max(0,pages.findIndex(page=>page.start<=anchor&&anchor<page.end));
    return true;
  }
  function renderMemory() {
    const all=datasets.get(memoryBook);if(!all)return;const rows=all.slice(memoryRange.from-1,memoryRange.to);
    if(!planMemoryPages(rows))return;
    const pageCount=memoryPages.length;memoryPage=Math.max(0,Math.min(memoryPage,pageCount-1));
    const {start,end}=memoryPages[memoryPage],fragment=document.createDocumentFragment();
    for(let index=start;index<end;index++)fragment.append(memoryRow(rows[index],memoryColumnWidths[index]));
    $('memorySheet').replaceChildren(fragment);$('memorySheet').classList.toggle('meanings-hidden',meaningsHidden);
    $('memorySheet').setAttribute('aria-label',books[memoryBook].kind+' '+rows[start].number+'〜'+rows[end-1].number);
    $('memorizeRange').textContent=rows[start].number+'–'+rows[end-1].number;
    $('memoryPrevious').disabled=memoryPage===0;$('memoryNext').disabled=false;
    $('memoryNext').textContent=memoryPage===pageCount-1?'終了':'次へ';
    $('memoryNext').setAttribute('aria-label',memoryPage===pageCount-1?'暗記を終了':'次のページ');
    if($('memoryPage').options.length!==pageCount){const options=document.createDocumentFragment();for(let index=0;index<pageCount;index++){const option=element('option','',index+1);option.value=String(index);options.append(option);}$('memoryPage').replaceChildren(options);}
    $('memoryPage').value=String(memoryPage);$('memoryPageTotal').textContent='/ '+pageCount;
    $('meaningsToggle').textContent=meaningsHidden?'訳を表示':'訳を隠す';$('meaningsToggle').setAttribute('aria-pressed',String(meaningsHidden));
  }
  function memoryNext({fromSheet=false}={}) {
    if(!datasets.has(memoryBook)){openMemory();return;}
    if(memoryPage>=memoryPages.length-1){if(fromSheet)toast('最後のページです');else home();return;}
    memoryPage++;renderMemory();window.scrollTo({top:0,behavior:'instant'});
  }
  function queueMemoryLayout() {
    if(activeView!=='memorize'||memoryLayoutFrame)return;
    memoryLayoutFrame=requestAnimationFrame(()=>{memoryLayoutFrame=0;if(activeView==='memorize')renderMemory();});
  }
  if(typeof ResizeObserver==='function')new ResizeObserver(queueMemoryLayout).observe($('memorySheet'));
  window.addEventListener('resize',queueMemoryLayout);
  document.fonts?.ready.then(()=>{memoryLayoutKey='';queueMemoryLayout();});
  function openSetup({review=false}={}) {
    setupMode=review?'review':'normal';clearMastery();$('setupTitle').textContent=review?'解き直し':'テスト';
    $('setupBook').textContent=books[selectedBook].title;
    renderSectionControls();prepareSound();if(soundEnabled)bonus.prepare();void dataset(selectedBook).catch(()=>{});
    setError('setupError');startRetry=null;renderIdentity();show('setup');
  }
  function questionShape(question) {
    if(!question||typeof question!=='object'||typeof question.id!=='string'||!question.id||question.id.length>150||typeof question.prompt!=='string'||!question.prompt||question.prompt.length>3000||!Number.isSafeInteger(question.number)||question.number<1||!Array.isArray(question.choices)||question.choices.length!==4||question.choices.some(c=>!c||typeof c.id!=='string'||!c.id||c.id.length>150||typeof c.text!=='string'||!c.text||c.text.length>3000)||new Set(question.choices.map(c=>c.id)).size!==4||new Set(question.choices.map(c=>normalize(c.text))).size!==4)throw appError('問題の内容を確認できませんでした。テストを終了して、もう一度お試しください。');
    return question;
  }
  function kobunMeanings(value) {return new Set(value.normalize('NFKC').split(/[。；;]/u).map(part=>part.replace(/\s+/gu,' ').trim()).filter(Boolean));}
  function guestQuestions(rows,settings) {
    const pool=rows.filter(row=>row.number>=settings.from&&row.number<=settings.to),selected=shuffle(pool).slice(0,settings.count);
    const answerField=settings.direction==='english'?'english':'japanese',promptField=settings.direction==='english'?'japanese':'english';
    return selected.map(row=>{
      const texts=new Set([normalize(row[answerField])]),correctChoiceId=uuid(),meanings=settings.book==='kobun400'?kobunMeanings(row.japanese):null;
      const choices=[{id:correctChoiceId,text:row[answerField]}];
      for(const other of shuffle(rows)){
        const normalized=normalize(other[answerField]);
        if(other.id===row.id||normalize(other.japanese)===normalize(row.japanese)||normalize(other.english)===normalize(row.english)||texts.has(normalized))continue;
        if(meanings&&[...kobunMeanings(other.japanese)].some(meaning=>meanings.has(meaning)))continue;
        choices.push({id:uuid(),text:other[answerField]});texts.add(normalized);if(choices.length===4)break;
      }
      if(choices.length!==4)throw appError('異なる4つの選択肢を用意できませんでした。');
      return {id:uuid(),prompt:row[promptField],number:row.number,choices:shuffle(choices),correctChoiceId,correctText:row[answerField]};
    });
  }
  async function startTest(event) {
    event.preventDefault();if(starting)return;setError('setupError');
    const review=setupMode==='review';
    const {from,to}=review?{from:1,to:books[selectedBook].total}:selectedWordRange(),count=Number($('questionCount').value),direction=document.querySelector('input[name=direction]:checked')?.value;
    if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from<1||to<from||to>books[selectedBook].total||![10,50,100].includes(count)||!['english','japanese'].includes(direction)){setError('setupError','出題範囲と問題数を確認してください。');return;}
    if(review&&!member){setError('setupError','解き直しにはログインが必要です。');return;}
    const settings={book:selectedBook,direction,count,from,to},key=JSON.stringify({...settings,review}),epoch=sessionEpoch;
    if(!startRetry||startRetry.key!==key)startRetry={key,requestId:uuid()};
    const attempt=startRetry,currentSetup=()=>epoch===sessionEpoch&&activeView==='setup'&&startRetry===attempt;
    starting=true;prepareSound();$('testStart').disabled=true;renderIdentity();
    try {
      let created;
      if(member){
        void dataset(settings.book).catch(()=>{});
        const data=await api(review?'/quiz/review/start':'/quiz/start',{...settings,requestId:attempt.requestId});
        if(!currentSetup())return;
        if(typeof data.quizId!=='string'||!data.quizId||!Number.isSafeInteger(data.total)||data.total<1||data.total>count||data.answeredCount!==0||data.correctCount!==0||data.quizPoints!==0)throw appError('テストの準備結果を確認できませんでした。');
        bonus.update(checkedBonus(data.bonus),data.__timing);
        created={recorded:true,id:data.quizId,total:data.total,answeredCount:0,correctCount:0,quizPoints:0,question:questionShape(data.question)};
      }else{
        const questions=guestQuestions(await dataset(settings.book),settings);
        if(!currentSetup())return;
        created={recorded:false,id:uuid(),total:questions.length,answeredCount:0,correctCount:0,quizPoints:0,question:questions[0],questions};
      }
      quiz={...created,settings:{...settings,review},pending:false,pendingAnswer:null,feedback:null,localFeedback:null,finished:false,sessionEpoch:epoch};startRetry=null;lastAdvanceTap=null;
      show('quiz');renderQuestion();
    } catch(error) {
      if(!currentSetup())return;
      if(error.status===401){bonus.reset();clearMastery();member=null;lifetimeCorrect=0;lifetimePoints=0;walletBalance=0;walletKnown=false;sessionKnown=true;sessionEpoch++;renderIdentity();}
      setError('setupError',error.code==='REVIEW_EMPTY'?'解き直す単語はありません。':error.message);
    } finally {starting=false;$('testStart').disabled=false;renderIdentity();}
  }
  function renderQuestion() {
    if(!quiz)return;const question=questionShape(quiz.question),fragment=document.createDocumentFragment();
    $('questionPosition').textContent=(quiz.answeredCount+1)+' / '+quiz.total+'問';$('quizCorrect').textContent=quiz.correctCount+'問 正解';$('quizPoints').textContent=gou(quiz.quizPoints);
    $('quizProgress').max=quiz.total;$('quizProgress').value=quiz.answeredCount;
    $('quizMode').textContent=quiz.recorded?'ランキングに記録':'ゲスト';
    $('questionNumber').textContent='No. '+question.number;
    $('questionInstruction').textContent=(quiz.settings.direction==='english'?books[quiz.settings.book].wordLabel:books[quiz.settings.book].meaningLabel)+'を選んでください';
    $('questionPrompt').textContent=question.prompt;$('questionPrompt').closest('.question-card').classList.toggle('english-prompt',quiz.settings.direction==='japanese');
    question.choices.forEach((choice,index)=>{const button=element('button','choice-button');button.type='button';button.dataset.choiceId=choice.id;button.setAttribute('aria-pressed','false');button.append(element('span','choice-letter',String.fromCharCode(65+index)),element('span','choice-text',choice.text));button.addEventListener('click',event=>selectChoice(choice.id,event));fragment.append(button);});
    $('questionChoices').replaceChildren(fragment);$('answerFeedback').hidden=true;$('answerRetry').hidden=true;setError('quizError');
    quiz.feedback=null;quiz.localFeedback=null;quiz.pendingAnswer=null;quiz.pendingGuestResult=null;quiz.soundPlayed=false;clearRewardCelebration();
    requestAnimationFrame(()=>{if(activeView==='quiz')$('questionPrompt').focus({preventScroll:true});});
  }
  function selectChoice(choiceId,event){
    if(!quiz||quiz.pending||quiz.pendingAnswer||quiz.feedback||quiz.sessionEpoch!==sessionEpoch)return;
    if(event?.detail>1||(event&&repeatsAdvanceTap(event)))return;
    if(!quiz.question.choices.some(choice=>choice.id===choiceId))return;
    bonus.gesture();
    for(const button of $('questionChoices').querySelectorAll('button')){const selected=button.dataset.choiceId===choiceId;button.classList.toggle('selected',selected);button.setAttribute('aria-pressed',String(selected));}
    const known=quiz.recorded?materialFeedback(quiz,choiceId):{correct:choiceId===quiz.question.correctChoiceId};
    if(known)feedbackSound(quiz,known.correct);
    void answer(choiceId);
  }
  function materialFeedback(current,choiceId){
    const row=datasets.get(current.settings.book)?.[current.question.number-1];if(!row)return null;
    const promptField=current.settings.direction==='english'?'japanese':'english',answerField=current.settings.direction==='english'?'english':'japanese';
    if(current.question.prompt!==row[promptField])return null;
    const matches=current.question.choices.filter(choice=>choice.text===row[answerField]);if(matches.length!==1)return null;
    return {correct:matches[0].id===choiceId,correctChoiceId:matches[0].id,correctText:matches[0].text};
  }
  function renderAnswerFeedback(result){
    for(const button of $('questionChoices').querySelectorAll('button')){button.disabled=true;button.classList.toggle('is-correct',button.dataset.choiceId===result.correctChoiceId);button.classList.toggle('is-wrong',!result.correct&&button.dataset.choiceId===quiz.pendingAnswer?.choiceId);}
    $('feedbackTitle').textContent=result.correct?'正解':'不正解';$('feedbackAnswer').textContent=result.correct?'':'正解：'+result.correctText;$('answerFeedback').classList.toggle('is-wrong',!result.correct);$('answerFeedback').hidden=false;
  }
  function showAnswerResult(result) {
    if(!quiz)return;
    const question=quiz.question;
    const correctChoice=question.choices.find(choice=>choice.id===result.correctChoiceId);
    if(typeof result.correct!=='boolean'||typeof result.correctChoiceId!=='string'||!correctChoice||typeof result.correctText!=='string'||result.correctText!==correctChoice.text||result.correct!==(quiz.pendingAnswer?.choiceId===result.correctChoiceId)||!Number.isSafeInteger(result.answeredCount)||result.answeredCount!==quiz.answeredCount+1||!Number.isSafeInteger(result.correctCount)||result.correctCount!==quiz.correctCount+(result.correct?1:0)||result.total!==quiz.total||result.finished!==(result.answeredCount===quiz.total))throw appError('回答結果を確認できませんでした。同じ回答を再送してください。');
    if(!validPoints(result.awardPoints)||![0,100,500,1000,10000,100000].includes(result.awardPoints)||(!result.correct&&result.awardPoints!==0)||!validPoints(result.quizPoints)||result.quizPoints!==quiz.quizPoints+result.awardPoints||!validPoints(result.totalPoints)||result.totalPoints<result.quizPoints)throw appError('得点を確認できませんでした。同じ回答を再送してください。');
    if(!result.finished)questionShape(result.nextQuestion);
    const bonusState=checkedBonus(result.bonus);if(quiz.recorded)bonus.update(bonusState,result.__timing);
    quiz.feedback=result;quiz.answeredCount=result.answeredCount;quiz.correctCount=result.correctCount;quiz.quizPoints=result.quizPoints;quiz.finished=result.finished;
    renderAnswerFeedback(result);feedbackSound(quiz,result.correct);
    $('quizPoints').textContent=gou(quiz.quizPoints);
    if(quiz.recorded){clearMastery();sessionTicket++;lifetimePoints=Math.max(lifetimePoints,result.totalPoints);walletKnown=false;renderIdentity();if($('settingsDialog').open)void refreshSession({notify:false,walletFeedback:true});}
    $('quizCorrect').textContent=quiz.correctCount+'問 正解';$('quizProgress').value=quiz.answeredCount;
    $('quizMode').textContent=quiz.recorded?'ランキングに記録':'ゲスト';
    $('answerRetry').hidden=true;beginResultDisplay();
    setError('quizError');
  }
  async function answer(choiceId,{retry=false}={}) {
    const current=quiz;if(!current||current.pending||current.feedback||current.sessionEpoch!==sessionEpoch)return;
    if(current.pendingAnswer&&!retry)return;
    if(!current.question.choices.some(choice=>choice.id===choiceId))return;
    if(!current.pendingAnswer)current.pendingAnswer={quizId:current.id,questionId:current.question.id,choiceId,requestId:uuid()};
    current.pending=true;$('answerRetry').disabled=true;setError('quizError');
    for(const button of $('questionChoices').querySelectorAll('button')){button.disabled=true;button.classList.toggle('selected',button.dataset.choiceId===choiceId);}
    if(current.recorded){
      current.localFeedback=materialFeedback(current,choiceId);
      if(current.localFeedback){renderAnswerFeedback(current.localFeedback);feedbackSound(current,current.localFeedback.correct);}
      $('quizMode').textContent='記録中…';
    }
    try {
      let result;
      if(current.recorded){result=await api('/quiz/answer',current.pendingAnswer);}
      else{
        if(!current.pendingGuestResult){
          const correct=choiceId===current.question.correctChoiceId,answered=current.answeredCount+1,awardPoints=correct?(bonus.active()?500:guestAward()):0,quizPoints=current.quizPoints+awardPoints;
          if(awardPoints===100000)bonus.startGuest();
          current.pendingGuestResult={correct,correctChoiceId:current.question.correctChoiceId,correctText:current.question.correctText,answeredCount:answered,correctCount:current.correctCount+(correct?1:0),awardPoints,quizPoints,totalPoints:quizPoints,bonus:bonus.snapshot(),total:current.total,finished:answered===current.total,nextQuestion:current.questions[answered]||null};
        }
        result=current.pendingGuestResult;
      }
      if(quiz!==current||current.sessionEpoch!==sessionEpoch)return;showAnswerResult(result);
    } catch(error) {
      if(quiz!==current||current.sessionEpoch!==sessionEpoch)return;
      clearRewardCelebration();
      if(error.status===401){bonus.reset();clearMastery();member=null;lifetimeCorrect=0;lifetimePoints=0;walletBalance=0;walletKnown=false;sessionKnown=true;sessionEpoch++;renderIdentity();}
      $('quizMode').textContent=current.recorded?'記録未確認':'ゲスト';
      setError('quizError',error.message+' 回答は保持しています。');$('answerRetry').hidden=error.status===401;
    } finally {current.pending=false;if(quiz===current)$('answerRetry').disabled=false;}
  }
  function nextQuestion(display=resultDisplay) {
    if(!liveResultDisplay(display)||quiz.pending)return false;
    cancelResultAdvance();hideRewardVisual();stopSound();
    if(quiz.finished){showResult();return true;}
    quiz.question=quiz.feedback.nextQuestion;renderQuestion();window.scrollTo({top:0,behavior:'instant'});
    return true;
  }
  function showResult() {
    if(!quiz)return;
    $('resultBook').textContent=books[quiz.settings.book].title;$('resultCorrect').textContent=String(quiz.correctCount);$('resultTotal').textContent='/ '+quiz.total+'問';$('resultPoints').textContent=gou(quiz.quizPoints);
    $('resultMode').textContent=quiz.recorded?'ランキングに記録':'ゲスト（記録なし）';show('result');
    $('testAgain').textContent=quiz.settings.review?'もう一度解き直し':'もう一度テスト';
    if(quiz.recorded)void refreshSession({notify:false});
  }
  function openQuit() {
    pauseResultDisplay();
    if(!quiz||quiz.finished){home();return;}
    $('quitDescription').textContent=quiz.recorded?(quiz.pendingAnswer&&!quiz.feedback?'回答の記録を確認できていません。':'回答済みの得点は記録されています。'):'ゲスト練習の途中経過は保存されません。';$('quitDialog').showModal();
  }
  async function openRanking() {show('ranking');await loadRanking();}
  async function loadRanking(target='ranking') {
    const preview=target==='homeRanking',ticket=++rankingTickets[target];
    setError(target+'Error');$(target+'Status').textContent='読み込み中…';$(target+'List').replaceChildren();
    if(!preview)$('rankingRefresh').disabled=true;
    try {
      const data=await api('/ranking');if(ticket!==rankingTickets[target])return;
      if(!Array.isArray(data.ranking)||data.ranking.length>1000||data.ranking.some(row=>!row||!Number.isSafeInteger(row.rank)||row.rank<1||typeof row.name!=='string'||row.name.length>20||!validPoints(row.totalPoints)))throw appError('ランキングの内容を確認できませんでした。');
      const fragment=document.createDocumentFragment();
      for(const row of (preview?data.ranking.slice(0,10):data.ranking)){const item=element('li','ranking-row'),score=element('span','ranking-score',row.totalPoints.toLocaleString('ja-JP'));score.append(element('small','', '轟'));item.append(element('span','ranking-place',row.rank),element('span','ranking-name',row.name.trim()||'名前未設定'),score);fragment.append(item);}
      $(target+'List').replaceChildren(fragment);$(target+'Status').textContent=data.ranking.length?'':'まだテストの記録はありません。';
    } catch(error) {if(ticket===rankingTickets[target]){$(target+'Status').textContent='';setError(target+'Error',error.message);}}
    finally {if(!preview&&ticket===rankingTickets[target])$('rankingRefresh').disabled=false;}
  }
  function setPinVisible(visible) {$('accountPin').type=visible?'text':'password';$('pinVisibility').textContent=visible?'隠す':'表示';$('pinVisibility').setAttribute('aria-pressed',String(visible));$('pinVisibility').setAttribute('aria-label',visible?'PINを隠す':'PINを表示');}
  function openSettings() {pauseResultDisplay();setError('settingsError');$('settingsStatus').textContent='';walletKnown=false;renderIdentity();$('settingsDialog').showModal();void refreshSession({notify:false,walletFeedback:true});}
  async function login(event) {
    event.preventDefault();if(loginPending||logoutPending)return;setError('settingsError');$('settingsStatus').textContent='';
    const attendanceNumber=Number($('attendanceNumber').value),accountPin=$('accountPin').value;
    if(!/^[0-9]{1,2}$/.test($('attendanceNumber').value)||!((attendanceNumber>=1&&attendanceNumber<=40)||attendanceNumber===99)||!/^[0-9]{4}$/.test(accountPin)){setError('settingsError','出席番号と4桁のPINを確認してください。');return;}
    loginPending=true;for(const id of ['attendanceNumber','accountPin','pinVisibility','loginButton'])$(id).disabled=true;$('loginButton').textContent='ログイン中…';
    try {
      const identity=parseIdentity(await api('/login',{attendanceNumber,accountPin}));if(!identity.member)throw appError('ログイン情報を確認できませんでした。');
      clearRewardCelebration();bonus.reset();clearMastery();sessionEpoch++;sessionTicket++;member=identity.member;lifetimeCorrect=identity.correctCount;lifetimePoints=identity.totalPoints;walletBalance=identity.balance;walletKnown=!!member;sessionKnown=true;bonus.update(identity.bonus,identity.timing);$('accountPin').value='';$('attendanceNumber').value='';setPinVisible(false);$('connectionNotice').hidden=true;renderIdentity();$('settingsStatus').textContent='ログインしました。';
      if(activeView==='mastery')void loadMastery();
      if(activeView==='home')void loadHomeReview();
    } catch(error){setError('settingsError',error.message);}
    finally{loginPending=false;for(const id of ['attendanceNumber','accountPin','pinVisibility','loginButton'])$(id).disabled=false;$('loginButton').textContent='ログイン';if(!$('settingsDialog').open){$('accountPin').value='';setPinVisible(false);}}
  }
  async function logout() {
    if(loginPending||logoutPending)return;logoutPending=true;$('logoutButton').disabled=true;setError('settingsError');$('settingsStatus').textContent='';
    try {
      await api('/logout',{});clearRewardCelebration();bonus.reset();clearMastery();sessionEpoch++;sessionTicket++;member=null;lifetimeCorrect=0;lifetimePoints=0;walletBalance=0;walletKnown=false;sessionKnown=true;$('accountPin').value='';$('attendanceNumber').value='';setPinVisible(false);renderIdentity();$('settingsStatus').textContent='ログアウトしました。';
      if(activeView==='mastery')void loadMastery();
      if(activeView==='quiz'&&quiz?.recorded){quiz=null;home();}
    } catch(error){setError('settingsError',error.message);}
    finally{logoutPending=false;$('logoutButton').disabled=false;}
  }

  $('bookSelect').addEventListener('change',()=>selectBook($('bookSelect').value));
  for(const [id,part] of [['homeSectionFrom','from'],['homeSectionTo','to'],['rangeFrom','from'],['rangeTo','to']])$(id).addEventListener('change',()=>changeSection(part,$(id).value));
  $('questionCount').addEventListener('change',()=>{startRetry=null;});
  for(const input of document.querySelectorAll('input[name=direction]'))input.addEventListener('change',()=>{startRetry=null;});
  for(const button of document.querySelectorAll('[data-home]'))button.addEventListener('click',goHome);
  $('brandHome').addEventListener('click',goHome);$('memorizeOpen').addEventListener('click',openMemory);$('testOpen').addEventListener('click',openSetup);
  $('memoryNext').addEventListener('click',()=>memoryNext());$('memoryPrevious').addEventListener('click',()=>{if(memoryPage>0){memoryPage--;renderMemory();window.scrollTo({top:0,behavior:'instant'});}});
  $('memoryPage').addEventListener('change',()=>{memoryPage=Number($('memoryPage').value);renderMemory();window.scrollTo({top:0,behavior:'instant'});});
  $('meaningsToggle').addEventListener('click',()=>{meaningsHidden=!meaningsHidden;renderMemory();});
  $('memorySheet').addEventListener('click',()=>{if(window.getSelection()?.toString())return;memoryNext({fromSheet:true});});
  $('testForm').addEventListener('submit',startTest);$('answerRetry').addEventListener('click',()=>{if(quiz?.pendingAnswer)void answer(quiz.pendingAnswer.choiceId,{retry:true});});
  $('quizAdvanceSurface').addEventListener('click',advanceByTap);
  $('quizAdvanceSurface').addEventListener('pointerdown',event=>{if(event.button!==0||event.isPrimary===false||!liveResultDisplay(resultDisplay))return;clearTimeout(resultTimer);resultTimer=undefined;resultPointer={id:event.pointerId,display:resultDisplay};});
  document.addEventListener('pointerup',releaseResultPointer,true);document.addEventListener('pointercancel',releaseResultPointer,true);
  document.addEventListener('keydown',event=>{if(event.repeat||!['Enter',' '].includes(event.key)||!liveResultDisplay(resultDisplay)||['INPUT','SELECT','TEXTAREA'].includes(document.activeElement?.tagName)||document.activeElement?.closest('button'))return;event.preventDefault();bonus.gesture();nextQuestion(resultDisplay);});
  $('quizQuit').addEventListener('click',openQuit);$('quitCancel').addEventListener('click',()=>$('quitDialog').close());$('quitConfirm').addEventListener('click',()=>{quiz=null;$('quitDialog').close();home();});
  $('quitDialog').addEventListener('close',()=>{if(confirmedResult())beginResultDisplay();});
  $('resultView').addEventListener('click',event=>{if(event.target.closest('button,a')&&repeatsAdvanceTap(event)){event.preventDefault();event.stopImmediatePropagation();}},true);
  $('testAgain').addEventListener('click',()=>{if(quiz)selectedBook=quiz.settings.book;selectBook(selectedBook);openSetup({review:!!quiz?.settings.review});});
  $('masteryOpen').addEventListener('click',openMastery);$('masteryRefresh').addEventListener('click',()=>void loadMastery());
  $('reviewOpen').addEventListener('click',()=>openSetup({review:true}));
  $('homeReviewRetry').addEventListener('click',()=>void loadHomeReview());
  $('masteryLogin').addEventListener('click',openSettings);$('reviewLogin').addEventListener('click',openSettings);
  $('rankingOpen').addEventListener('click',openRanking);$('resultRanking').addEventListener('click',openRanking);$('rankingRefresh').addEventListener('click',()=>loadRanking());
  $('soundSetting').addEventListener('change',()=>setSoundEnabled($('soundSetting').value==='on',{preview:true}));
  $('settingsOpen').addEventListener('click',openSettings);$('settingsClose').addEventListener('click',()=>$('settingsDialog').close());$('loginForm').addEventListener('submit',login);$('logoutButton').addEventListener('click',logout);$('pinVisibility').addEventListener('click',()=>setPinVisible($('accountPin').type==='password'));
  $('sourcesOpen').addEventListener('click',event=>{event.preventDefault();pauseResultDisplay();$('sourcesDialog').showModal();});$('sourcesClose').addEventListener('click',()=>$('sourcesDialog').close());
  $('settingsDialog').addEventListener('close',()=>{if(!loginPending){$('accountPin').value='';setPinVisible(false);}if(confirmedResult())beginResultDisplay();});
  $('sourcesDialog').addEventListener('close',()=>{if(confirmedResult())beginResultDisplay();});
  document.addEventListener('keydown',event=>{if(activeView!=='memorize'||document.querySelector('dialog[open]')||['INPUT','SELECT','TEXTAREA','BUTTON'].includes(document.activeElement?.tagName))return;if(event.key==='ArrowRight'){event.preventDefault();memoryNext({fromSheet:true});}if(event.key==='ArrowLeft'&&memoryPage>0){event.preventDefault();memoryPage--;renderMemory();window.scrollTo({top:0,behavior:'instant'});}});
  home();void refreshSession();
})();
