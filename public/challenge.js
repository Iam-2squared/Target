'use strict';
(() => {
  const $=id=>document.getElementById(id);
  const make=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=String(text);return node;};
  const uuid=()=>crypto.randomUUID();
  const validId=value=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
  const titles=['はじまりの草原','木漏れ日の森','霧の渓谷','水晶の洞窟','砂塵の遺跡','氷晶の峰','雷鳴の神殿','灼熱の火山','闇夜の王都','魔王城'];
  const mobs=['草原のスライム','森の番人','渓谷の翼獣','洞窟の守護者','砂漠の毒蠍','氷の狼','雷の騎士','炎の竜','闇の将軍','魔王'];
  const terminal=run=>run&&['won','lost','aborted'].includes(run.status);
  let active=false,epoch=0,callbacks={},identity=null,levels=[],run=null,mode='map';
  let inFlight=false,pending=null,pauseOperation=null,pauseIntent=false,homeIntent=false;
  let pollTimer=null,pollFailures=0,mapNeeded=false,message='',feedback='',feedbackTimer=null;
  let drawnQuestion=null,drawnMode='',lastHp=null;

  function art(kind,level){return window.ChallengeArt?.[kind]?.(level)||'';}
  function svgNode(kind,level,cls){const node=make('span',cls);node.innerHTML=art(kind,level);node.setAttribute('aria-hidden','true');return node;}
  function scene(node,level){const url=art('sceneURL',level);if(url)node.style.backgroundImage='url("'+url.replace(/"/g,'%22')+'")';}
  function button(label,cls,action){const node=make('button',cls,label);node.type='button';node.addEventListener('click',action);return node;}
  function clearTimers(){clearTimeout(pollTimer);pollTimer=null;clearTimeout(feedbackTimer);feedbackTimer=null;}
  function schedule(delay){
    clearTimeout(pollTimer);
    if(!active)return;
    const wait=delay??(pollFailures?Math.min(15000,1200*2**Math.min(4,pollFailures)):run?.status==='playing'?650:run?.status==='paused'?8000:20000);
    pollTimer=setTimeout(()=>void refresh(),wait);
  }
  function showMessage(text=''){message=text;const node=$('challengeStatus');if(node){node.textContent=text;node.hidden=!text;}}
  function checkRun(value){
    if(value===null)return null;
    if(!value||!validId(value.id)||!Number.isInteger(value.level)||value.level<1||value.level>10||
      !['playing','paused','won','lost','aborted'].includes(value.status)||
      !Number.isSafeInteger(value.playerHp)||!Number.isSafeInteger(value.enemyHp)||
      !Number.isSafeInteger(value.playerMaxHp)||!Number.isSafeInteger(value.enemyMaxHp)||
      value.playerMaxHp<=0||value.enemyMaxHp<=0||value.playerHp<0||value.enemyHp<0||
      value.playerHp>value.playerMaxHp||value.enemyHp>value.enemyMaxHp)throw new Error('挑戦データを確認できませんでした。');
    if(value.status==='paused'&&value.question!==null)throw new Error('停止状態を確認できませんでした。');
    if(value.question){
      const q=value.question;
      if(value.status!=='playing'||!validId(q.id)||typeof q.prompt!=='string'||!Array.isArray(q.choices)||q.choices.length!==4||
        q.choices.some(c=>!validId(c.id)||typeof c.text!=='string')||new Set(q.choices.map(c=>c.id)).size!==4)throw new Error('問題を確認できませんでした。');
    }
    return value;
  }
  async function api(action,body,{keepalive=false}={}){
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),12000);
    try{
      const response=await fetch('/api/challenge/'+action,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',redirect:'error',keepalive,
        headers:body===undefined?{Accept:'application/json'}:{Accept:'application/json','Content-Type':'application/json'},
        body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal});
      let data;try{data=await response.json();}catch{throw new Error('サーバーの応答を確認できませんでした。');}
      if(!response.ok||data?.error){const error=new Error(data?.error?.message||'接続を確認できませんでした。');error.status=response.status;error.code=data?.error?.code;throw error;}
      if(data?.ok!==true)throw new Error('挑戦データを確認できませんでした。');
      return data;
    }catch(error){if(error.name==='AbortError')throw new Error('通信に時間がかかっています。');throw error;}
    finally{clearTimeout(timeout);}
  }
  function accept(data,{map=false}={}){
    if(map){
      if(!Array.isArray(data.levels)||data.levels.length!==10||data.levels.some((l,i)=>l?.level!==i+1||typeof l.unlocked!=='boolean'||typeof l.cleared!=='boolean'))throw new Error('ステージを確認できませんでした。');
      levels=data.levels;
      if(!run&&data.activeRun){run=checkRun(data.activeRun);mode='game';pauseIntent=true;}
    }else if(Object.hasOwn(data,'run'))run=checkRun(data.run);
    if(pauseIntent&&run?.status==='playing')run={...run,question:null};
    if(data.wallet)callbacks.onWallet?.(data.wallet);
    if(terminal(run)){
      mode='result';pauseIntent=false;pauseOperation=null;pending=null;
      if(!map&&run.status!=='aborted')mapNeeded=true;
    }
  }
  function handleError(error){
    if(error.status===401){const unauthorized=callbacks.onUnauthorized;close();unauthorized?.();return;}
    pollFailures++;
    showMessage(error.message+(homeIntent?' 終了の確認待ちです。':pauseIntent?' 停止の確認待ちです。':''));
  }
  async function refresh(){
    if(!active||inFlight)return;
    if(pauseIntent&&['start','resume'].includes(pending?.action)){void perform(pending);return;}
    if(homeIntent&&pending?.action==='abort'){void perform(pending);return;}
    if(pauseIntent&&run?.status==='playing'){void confirmPause();return;}
    if(pending||pauseOperation){schedule();return;}
    if(document.hidden){schedule();return;}
    if(terminal(run)&&!mapNeeded)return;
    const lease=epoch,useMap=mode==='map'||mapNeeded||!run;
    inFlight=true;
    try{
      const data=await api(useMap?'map':'state?runId='+encodeURIComponent(run.id));
      if(!active||lease!==epoch)return;
      if(useMap)mapNeeded=false;
      accept(data,{map:useMap});pollFailures=0;showMessage('');
    }catch(error){if(active&&lease===epoch)handleError(error);}
    finally{if(active&&lease===epoch){inFlight=false;render();afterRequest();}}
  }
  function afterRequest(){
    if(!active)return;
    // Resolve an uncertain start/resume receipt before pausing. A delayed
    // original must not arrive after our pause and restart the clock offscreen.
    if(pauseIntent&&['start','resume'].includes(pending?.action)){if(pollFailures)schedule();else void perform(pending);return;}
    if(homeIntent&&pending?.action==='abort'){if(pollFailures)schedule();else void perform(pending);return;}
    if(pauseIntent&&run?.status==='playing'){if(pauseOperation&&pollFailures)schedule();else void confirmPause();return;}
    if(homeIntent&&run?.status==='paused'&&!pending&&!pauseOperation){void perform({action:'abort',body:{requestId:uuid(),runId:run.id}});return;}
    if(homeIntent&&(!run||terminal(run))&&!pending&&!pauseOperation){const go=callbacks.onHome;close();go?.();return;}
    if(mapNeeded&&!pending&&!pauseOperation){schedule(0);return;}
    schedule();
  }
  async function perform(operation){
    if(!active||inFlight)return;
    inFlight=true;clearTimeout(pollTimer);const lease=epoch;
    if(operation.action!=='pause')pending=operation;
    render();
    try{
      const data=await api(operation.action,operation.body,{keepalive:['pause','abort'].includes(operation.action)});
      if(!active||lease!==epoch)return;
      if(operation.action==='abort'&&!terminal(checkRun(data.run)))throw new Error('終了状態を確認できませんでした。');
      if(operation.action==='pause'){pauseOperation=null;pending=null;}
      else pending=null;
      if(operation.action==='resume')drawnQuestion=null;
      if(operation.action==='start'){mode='game';feedback='';drawnMode='';}
      accept(data);pollFailures=0;showMessage('');
      if(operation.action==='answer'&&data.answer){
        const a=data.answer;feedback=a.correct?(a.streakBonus?'5 COMBO · HP +'+(a.healedHp||0):'GOOD · −5'):'MISS · HP −10';
        clearTimeout(feedbackTimer);feedbackTimer=setTimeout(()=>{feedback='';const node=$('challengeFeedback');if(node)node.textContent='';},1000);
      }
    }catch(error){
      if(active&&lease===epoch){
        if(operation.action!=='abort'&&[400,404,409].includes(error.status)){
          if(operation.action==='pause')pauseOperation=null;else pending=null;
          // Read the authoritative question after an already accepted answer.
          if(operation.action==='answer'){drawnQuestion=null;if(run?.status==='playing')run={...run,question:null};}
          if(operation.action==='start'){run=null;mapNeeded=true;}
        }
        handleError(error);
      }
    }finally{if(active&&lease===epoch){inFlight=false;render();afterRequest();}}
  }
  function start(level){
    if(!active||inFlight||pending||homeIntent||!levels.some(l=>l.level===level&&l.unlocked))return;
    pauseIntent=false;homeIntent=false;void perform({action:'start',body:{requestId:uuid(),level}});
  }
  function answer(questionId,choiceId){
    if(!active||inFlight||pending||pauseIntent||run?.status!=='playing'||run.question?.id!==questionId)return;
    void perform({action:'answer',body:{requestId:uuid(),runId:run.id,questionId,choiceId}});
  }
  function requestPause(){
    if(!active||terminal(run)&&pending?.action!=='start')return;
    pauseIntent=true;feedback='';drawnQuestion=null;
    if(run)run={...run,question:null};
    render();
    if(!inFlight){if(['start','resume'].includes(pending?.action))void perform(pending);else void confirmPause();}
  }
  function confirmPause(){
    if(!active||inFlight||!run||run.status!=='playing'||pending?.action==='resume')return;
    if(!pauseOperation)pauseOperation={action:'pause',body:{requestId:uuid(),runId:run.id}};
    return perform(pauseOperation);
  }
  function resume(){
    if(inFlight||!active)return;
    if(homeIntent){retry();return;}
    if(pauseOperation){void perform(pauseOperation);return;}
    if(pauseIntent&&run?.status==='playing'){void confirmPause();return;}
    if(pending){if(pending.action==='resume')pauseIntent=false;void perform(pending);return;}
    if(run?.status==='paused'){pauseIntent=false;void perform({action:'resume',body:{requestId:uuid(),runId:run.id}});}
  }
  function leaveHome(){
    if(!active)return;
    homeIntent=true;
    if(pending?.action==='abort'){if(!inFlight)void perform(pending);return;}
    if(!run&&!inFlight&&!pending){afterRequest();return;}
    if(!run&&pending){requestPause();if(!inFlight)void perform(pending);return;}
    if(pending?.action==='start'){requestPause();return;}
    if(run?.status==='paused'&&pending){requestPause();return;}
    if(run?.status==='paused'||terminal(run)){afterRequest();return;}
    requestPause();
  }
  function backToMap(){
    if(inFlight||pending)return;
    run=null;mode='map';pauseIntent=false;pauseOperation=null;feedback='';drawnMode='';mapNeeded=true;
    render();void refresh();
  }
  function retry(){if(inFlight)return;if(pauseOperation)void perform(pauseOperation);else if(pending)void perform(pending);else if(homeIntent)afterRequest();else if(pauseIntent)void confirmPause();else void refresh();}

  function shell(){
    const root=$('challengeApp');root.replaceChildren();
    const status=make('p','challenge-status',message);status.id='challengeStatus';status.setAttribute('role','status');status.setAttribute('aria-live','polite');status.hidden=!message;
    root.append(status);
    return root;
  }
  function renderMap(){
    const root=shell(),header=make('div','challenge-map-header'),copy=make('div');
    copy.append(make('h1','','挑戦'));
    header.append(copy,button('ホーム','challenge-nav',()=>leaveHome()));root.prepend(header);
    const grid=make('div','challenge-map');grid.id='challengeMap';grid.setAttribute('aria-label','挑戦ステージ');
    for(const entry of levels){
      const level=entry.level,tile=button('','challenge-tile'+(entry.cleared?' is-cleared':'')+(!entry.unlocked?' is-locked':''),()=>start(level));
      tile.dataset.level=String(level);tile.disabled=!entry.unlocked||inFlight||!!pending;
      tile.setAttribute('aria-label','Lv.'+level+' '+titles[level-1]+(!entry.unlocked?' ロック中':entry.cleared?' クリア済み':''));
      const image=make('span','challenge-tile-art');scene(image,level);
      image.append(make('span','challenge-tile-level','Lv. '+level));
      if(entry.cleared)image.append(svgNode('badgeSVG',level,'challenge-tile-badge'));
      if(!entry.unlocked)image.append(make('span','challenge-lock','♜'));
      const copy=make('span','challenge-tile-copy');copy.append(make('strong','',titles[level-1]),make('span','challenge-tile-reward',(level*100000).toLocaleString('ja-JP')+'轟'));
      if(entry.cleared)copy.append(make('span','challenge-clear-check','✓ CLEAR'));
      tile.append(image,copy);grid.append(tile);
    }
    root.append(grid);
    if(!levels.length)root.append(make('div','challenge-loading','ステージを読み込み中…'));
    if(pending||message)root.append(button(pending?'もう一度確認':'再接続','secondary-button challenge-retry',retry));
  }
  function hp(role,label,value,max){
    const box=make('div','challenge-health challenge-health-'+role),heading=make('div','challenge-health-label');
    heading.append(make('strong','',label),make('span','',value+' / '+max));
    const track=make('div','challenge-health-track'),fill=make('span');fill.style.width=(value/max*100)+'%';track.append(fill);
    track.setAttribute('role','progressbar');track.setAttribute('aria-label',label+' HP');track.setAttribute('aria-valuemin','0');track.setAttribute('aria-valuemax',String(max));track.setAttribute('aria-valuenow',String(value));
    box.append(heading,track);return box;
  }
  function buildGame(){
    const root=shell(),level=run.level,header=make('div','challenge-game-header'),copy=make('div');
    copy.append(make('span','challenge-eyebrow','LEVEL '+String(level).padStart(2,'0')),make('h1','',titles[level-1]));
    const pause=button('中止','challenge-nav',requestPause);pause.id='challengePause';header.append(copy,pause);root.prepend(header);
    const arena=make('section','challenge-arena');arena.id='challengeArena';scene(arena,level);
    const enemy=make('div','challenge-enemy-health');enemy.id='challengeEnemyHealth';
    const mob=svgNode('mobSVG',level,'challenge-mob');mob.id='challengeMob';
    const strike=make('div','challenge-strike');strike.id='challengeStrike';strike.setAttribute('aria-hidden','true');
    arena.append(enemy,mob,strike);root.append(arena);
    const player=make('div','challenge-player-health');player.id='challengePlayerHealth';root.append(player);
    const region=make('section','challenge-question-region');region.id='challengeQuestionRegion';region.setAttribute('aria-label','問題と選択肢');root.append(region);
    const feedbackNode=make('p','challenge-feedback');feedbackNode.id='challengeFeedback';feedbackNode.setAttribute('role','status');feedbackNode.setAttribute('aria-live','polite');root.append(feedbackNode);
    drawnQuestion=null;
  }
  function renderQuestion(){
    const region=$('challengeQuestionRegion'),paused=pauseIntent||run.status==='paused';
    if(paused){
      // Remove the question and choices at once. The opaque panel never relies on blur.
      region.replaceChildren();drawnQuestion=null;region.classList.add('is-paused');
      const panel=make('div','challenge-pause-panel');panel.setAttribute('role','group');panel.setAttribute('aria-label','一時停止');
      const confirmed=run.status==='paused'&&!pauseOperation;
      panel.append(make('span','challenge-pause-mark','Ⅱ'),make('h2','',homeIntent?'終了を確認中…':confirmed?'PAUSED':'停止を確認中…'));
      const next=button(homeIntent?'再接続':confirmed?'続ける':pauseOperation&&!inFlight?'再接続':'続ける','primary-button',homeIntent?retry:resume);
      next.id='challengeResume';next.disabled=inFlight||!homeIntent&&!confirmed&&!pauseOperation;
      const homeButton=button('ホーム','secondary-button',leaveHome);homeButton.id='challengeHome';homeButton.disabled=inFlight;
      panel.append(next,homeButton);region.append(panel);return;
    }
    region.classList.remove('is-paused');
    const question=run.question;
    if(drawnQuestion!==question?.id){
      region.replaceChildren();drawnQuestion=question?.id||null;
      if(!question){region.append(make('div','challenge-question-loading','次の問題を準備中…'));return;}
      const prompt=make('h2','challenge-prompt',question.prompt);prompt.id='challengePrompt';
      const choices=make('div','challenge-choices');
      for(const [index,choice]of question.choices.entries()){
        const option=button('','challenge-choice',()=>answer(question.id,choice.id));option.dataset.choice=choice.id;
        option.append(make('span','challenge-choice-letter','ABCD'[index]),make('span','',choice.text));choices.append(option);
      }
      region.append(prompt,choices);
    }
    for(const option of region.querySelectorAll('button'))option.disabled=inFlight||!!pending;
    region.querySelector('.challenge-answer-retry')?.remove();
    if(pending&&!inFlight){const retryButton=button('同じ回答を確認','secondary-button challenge-answer-retry',retry);region.append(retryButton);}
  }
  function renderGame(){
    if(drawnMode!=='game')buildGame();
    const background=art('sceneURL',run.level);
    if(background)document.body.style.setProperty('--challenge-scene','url("'+background.replace(/"/g,'%22')+'")');
    $('challengeEnemyHealth').replaceChildren(hp('enemy',mobs[run.level-1],run.enemyHp,run.enemyMaxHp));
    $('challengePlayerHealth').replaceChildren(hp('player',identity.name||'YOU',run.playerHp,run.playerMaxHp));
    const previous=lastHp;
    if(previous&&previous.enemy>run.enemyHp){$('challengeMob').classList.remove('is-hit');void $('challengeMob').offsetWidth;$('challengeMob').classList.add('is-hit');}
    if(previous&&previous.player>run.playerHp){$('challengeArena').classList.remove('is-damaged');void $('challengeArena').offsetWidth;$('challengeArena').classList.add('is-damaged');}
    lastHp={player:run.playerHp,enemy:run.enemyHp};
    $('challengePause').disabled=pauseIntent||run.status==='paused';
    renderQuestion();$('challengeFeedback').textContent=pauseIntent?'':feedback;
    $('challengeStrike').style.setProperty('--attack-progress',String(Math.max(0,Math.min(1,(run.nextAttackInMs||0)/(run.attackIntervalMs||2000)))));
  }
  function renderClearers(root){
    const entry=levels.find(level=>level.level===run.level),names=Array.isArray(entry?.clearers)?entry.clearers:[];
    const section=make('section','challenge-clearers');section.append(make('h2','','このレベルのクリア達成者'));
    if(!names.length)section.append(make('p','',mapNeeded?'確認中…':'まだいません'));
    else{
      const list=make('ul');
      for(const name of names){const text=typeof name==='string'?name:typeof name?.name==='string'?name.name:null;if(text)list.append(make('li','',text));}
      section.append(list);
    }
    root.append(section);
  }
  function renderResult(){
    const root=shell(),won=run.status==='won',level=run.level;
    const panel=make('div','challenge-result '+(won?'is-victory':'is-defeat'));
    const artNode=make('div','challenge-result-scene');scene(artNode,level);artNode.append(svgNode(won?'badgeSVG':'mobSVG',level,'challenge-result-art'));panel.append(artNode);
    const copy=make('div','challenge-result-copy');copy.append(make('span','challenge-eyebrow','LEVEL '+String(level).padStart(2,'0')),make('h1','',won?'VICTORY!':'DEFEAT'));
    if(won)copy.append(make('p','challenge-result-note','お見事！'));
    if(won){
      const reward=Number.isSafeInteger(run.reward)&&run.reward>=0?run.reward:0;
      copy.append(make('strong','challenge-reward','+'+reward.toLocaleString('ja-JP')+'轟'));
      if(run.badgeAwarded)copy.append(make('p','challenge-earned','新しい紋章を獲得'));
    }
    const actions=make('div','challenge-result-actions');
    actions.append(button(won?'もう一度':'リトライ','primary-button',()=>start(level)),button('戻る','secondary-button',backToMap));
    for(const b of actions.children)b.disabled=inFlight||!!pending;
    copy.append(actions);panel.append(copy);root.append(panel);renderClearers(root);
    if(pending||message)root.append(button('もう一度確認','secondary-button challenge-retry',retry));
  }
  function render(){
    if(!active)return;
    if(terminal(run))mode='result';
    const next=mode==='game'&&run?'game':mode==='result'&&run?'result':'map';
    document.body.classList.toggle('challenge-is-game',next==='game');
    if(next!=='game')document.body.style.removeProperty('--challenge-scene');
    if(next==='game')renderGame();else if(next==='result')renderResult();else renderMap();
    drawnMode=next;showMessage(message);
  }
  function close(){
    active=false;epoch++;clearTimers();callbacks={};identity=null;levels=[];run=null;pending=null;pauseOperation=null;pauseIntent=false;homeIntent=false;
    inFlight=false;mode='map';mapNeeded=false;pollFailures=0;message='';feedback='';drawnMode='';drawnQuestion=null;lastHp=null;
    document.body.classList.remove('challenge-is-game');document.body.style.removeProperty('--challenge-scene');$('challengeApp')?.replaceChildren();
  }
  function open(member,options={}){
    close();if(!validId(member?.id)||typeof member.name!=='string')return;
    identity={id:member.id,name:member.name};callbacks=options;active=true;render();void refresh();
  }
  document.addEventListener('visibilitychange',()=>{
    if(!active)return;
    if(document.hidden){if(run?.status==='playing'||inFlight&&mode==='map'||['start','resume'].includes(pending?.action))requestPause();}
    else if(pauseOperation)void retry();else if(pauseIntent&&run?.status==='playing')void confirmPause();else void refresh();
  });
  window.addEventListener('pagehide',()=>{if(active&&run?.status==='playing')requestPause();});
  window.TargetChallengeUI={open,close,leaveHome,refresh};
})();
