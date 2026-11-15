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
  let inFlight=false,readInFlight=false,queuedAnswer=null,pending=null,pauseOperation=null,pauseIntent=false,homeIntent=false;
  let exitDestination='app',retryLevel=null,retryStart=null;
  let pollTimer=null,pollFailures=0,mapNeeded=false,message='',feedback='',feedbackTimer=null;
  let drawnQuestion=null,drawnMode='',lastHp=null;
  let layoutFrame=null,layoutSignature='';
  let specialTimer=null,specialKey=null,specialFinishRunId=null;
  let specialBeat=null,specialResume=null,manualPauseNeeded=false,canonicalNeeded=false;
  let specialUnderlay=[];
  let specialCancel=null;
  let sessionChange=null;
  const shownSpecials=new Set();
  let answerPreview=null,previewTimer=null;
  const shownPreviews=new Set();

  function art(kind,level){return window.ChallengeArt?.[kind]?.(level)||'';}
  function svgNode(kind,level,cls){const node=make('span',cls);node.innerHTML=art(kind,level);node.setAttribute('aria-hidden','true');return node;}
  function scene(node,level){const url=art('sceneURL',level);if(url)node.style.backgroundImage='url("'+url.replace(/"/g,'%22')+'")';}
  function button(label,cls,action){const node=make('button',cls,label);node.type='button';node.addEventListener('click',action);return node;}
  function clearTimers(){clearTimeout(pollTimer);pollTimer=null;clearTimeout(feedbackTimer);feedbackTimer=null;cancelAnimationFrame(layoutFrame);layoutFrame=null;clearPreview();clearSpecial();}
  function clearPreview(){clearTimeout(previewTimer);previewTimer=null;if(answerPreview)drawnQuestion=null;answerPreview=null;}
  function answerCount(value){return Number.isSafeInteger(value?.correctCount)&&Number.isSafeInteger(value?.wrongCount)?value.correctCount+value.wrongCount:null;}
  function currentPreview(preview){
    if(!active||preview.epoch!==epoch||run?.id!==preview.runId||answerCount(run)!==preview.count)return false;
    if(run.status==='paused')return preview.specialOwned&&run.updatedAt===preview.data.answer.specialPausedAt;
    return ['playing','won','lost'].includes(run.status);
  }
  function beginPreview(operation,data){
    const capture=operation.capture,a=data.answer;
    if(!capture||typeof a?.correct!=='boolean'||shownPreviews.has(operation.body.requestId)||document.hidden||pauseIntent||homeIntent||retryLevel!==null)return false;
    const question=capture.question,ids=question.choices.map(choice=>choice.id),chosen=operation.body.choiceId;
    if(question.id!==operation.body.questionId||!ids.includes(chosen)||capture.count===null)return false;
    const supplied=Object.hasOwn(a,'correctChoiceId');let correctId=supplied?a.correctChoiceId:null;
    if(supplied&&(typeof correctId!=='string'||!ids.includes(correctId)||(correctId===chosen)!==a.correct))return false;
    if(!correctId&&a.correct)correctId=chosen;
    const preview={operation,data,question,chosen,correctId,correct:a.correct,runId:operation.body.runId,count:capture.count+1,epoch,
      specialOwned:a.specialAttack===true&&a.specialPaused===true&&typeof a.specialPausedAt==='string'&&a.specialPausedAt===run?.updatedAt};
    if(!currentPreview(preview))return false;
    shownPreviews.add(operation.body.requestId);if(shownPreviews.size>128)shownPreviews.delete(shownPreviews.values().next().value);
    clearPreview();answerPreview=preview;mode='game';queuedAnswer=null;clearTimeout(pollTimer);pollTimer=null;
    previewTimer=setTimeout(()=>{
      if(answerPreview!==preview)return;
      const valid=currentPreview(preview)&&!document.hidden&&!pauseIntent&&!homeIntent&&retryLevel===null;
      clearPreview();
      if(valid)specialHit(operation,data);
      render();afterRequest();
    },450);
    return true;
  }
  function clearSpecial(){
    clearTimeout(specialTimer);specialTimer=null;specialKey=null;
    specialBeat=null;$('challengeSpecialHit')?.remove();document.body.classList.remove('challenge-special-open');
    for(const item of specialUnderlay){if(!item.node.isConnected)continue;item.node.inert=item.inert;if(item.hidden===null)item.node.removeAttribute('aria-hidden');else item.node.setAttribute('aria-hidden',item.hidden);}
    specialUnderlay=[];
  }
  function specialHit(operation,data){
    const requestId=operation.body.requestId,answer=data.answer;
    if(answer.specialAttack!==true||!validId(requestId)||shownSpecials.has(requestId)||
      !Number.isSafeInteger(answer.specialDamage)||answer.specialDamage<0)return false;
    shownSpecials.add(requestId);if(shownSpecials.size>128)shownSpecials.delete(shownSpecials.values().next().value);
    const matching=run?.id===operation.body.runId;
    const won=matching&&run.status==='won'&&Number.isSafeInteger(data.reward)&&data.reward>0;
    const owned=matching&&run.status==='paused'&&answer.specialPaused===true&&typeof answer.specialPausedAt==='string'&&answer.specialPausedAt===run.updatedAt;
    if(!active||document.hidden||pauseIntent||homeIntent||retryLevel!==null)return false;
    if(!owned&&!won)return matching&&run.status==='playing'&&data.replayed!==true&&answer.specialPaused!==true;
    clearSpecial();clearTimeout(pollTimer);pollTimer=null;queuedAnswer=null;specialKey=requestId;mode='game';
    const tier=answer.specialDamage<50?1:answer.specialDamage<150?2:answer.specialDamage<300?3:4;
    const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches,duration=reduced?900:[900,1200,1500,1800][tier-1];
    specialBeat={requestId,runId:run.id,epoch,pausedAt:answer.specialPausedAt,won,tier,duration};
    const effect=make('section','challenge-special-screen tier-'+tier);effect.id='challengeSpecialHit';effect.dataset.tier=String(tier);
    effect.setAttribute('role','dialog');effect.setAttribute('aria-modal','true');effect.setAttribute('aria-label','必殺 −'+answer.specialDamage);effect.style.setProperty('--special-duration',duration+'ms');scene(effect,run.level);
    const stop=button('中止','challenge-special-stop',requestPause);effect.append(stop);
    const stage=make('div','challenge-special-stage');stage.setAttribute('aria-hidden','true');stage.append(svgNode('mobSVG',run.level,'challenge-special-enemy'));
    const rings=make('div','challenge-special-rings');for(let i=0;i<tier;i++){const ring=make('i');ring.style.setProperty('--i',String(i));rings.append(ring);}stage.append(rings);
    for(let i=0;i<(tier>2?2:1);i++){const slash=make('i','challenge-special-slash');slash.style.setProperty('--i',String(i));stage.append(slash);}
    for(let i=0;i<(tier-1)*2;i++){const shard=make('i','challenge-special-shard');shard.style.setProperty('--i',String(i));stage.append(shard);}
    const label=make('div','challenge-special-label');label.append(make('strong','','必殺'),make('span','','−'+answer.specialDamage));stage.append(label);effect.append(stage);
    specialUnderlay=[...document.body.children].filter(node=>node instanceof HTMLElement&&node.tagName!=='SCRIPT').map(node=>({node,inert:node.inert,hidden:node.getAttribute('aria-hidden')}));
    for(const item of specialUnderlay){item.node.inert=true;item.node.setAttribute('aria-hidden','true');}
    document.body.append(effect);document.body.classList.add('challenge-special-open');
    effect.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();requestPause();}else if(event.key==='Tab'){event.preventDefault();stop.focus();}});
    stop.focus({preventScroll:true});
    specialTimer=setTimeout(()=>finishSpecial(requestId),duration);
    return true;
  }
  function finishSpecial(requestId){
    const beat=specialBeat;if(!beat||beat.requestId!==requestId||beat.epoch!==epoch||!active)return;
    if(document.hidden||pauseIntent||homeIntent||retryLevel!==null){requestPause();return;}
    const owned=run?.id===beat.runId&&run.status==='paused'&&run.updatedAt===beat.pausedAt;
    clearSpecial();render();
    if(beat.won){afterRequest();return;}
    if(!owned){canonicalNeeded=true;afterRequest();return;}
    specialResume={action:'resume',autoSpecial:true,body:{requestId:uuid(),runId:beat.runId,specialRequestId:beat.requestId}};
    void perform(specialResume);
  }
  function invalidateSpecial({force=false}={}){
    const runId=specialResume?.body.runId||specialBeat?.runId||(answerPreview?.specialOwned?answerPreview.runId:null)||specialCancel?.runId;
    if(!active||!validId(runId))return;
    if(run?.id===runId&&terminal(run)&&!specialResume&&!pending?.autoSpecial)return;
    if(specialResume)specialResume.cancelled=true;
    if(pending?.autoSpecial)pending.cancelled=true;
    if(!specialCancel||specialCancel.runId!==runId)specialCancel={runId,body:{requestId:uuid(),runId},promise:null,confirmed:false,retryAt:0,timer:null,data:null};
    const cancellation=specialCancel,lease=epoch;
    if(specialResume?.cancelled)specialResume.controller?.abort();
    if(cancellation.confirmed||cancellation.promise)return;
    clearTimeout(cancellation.timer);
    if(!force&&cancellation.retryAt>Date.now()){cancellation.timer=setTimeout(()=>invalidateSpecial(),cancellation.retryAt-Date.now());return;}
    cancellation.promise=(async()=>{
      try{
        const data=await api('pause',cancellation.body,{keepalive:true}),next=checkRun(data.run);
        if(!next||next.id!==runId||!['paused','won','lost','aborted'].includes(next.status))throw new Error('一時停止を確認できませんでした。');
        cancellation.confirmed=true;cancellation.data=data;
        if(!active||lease!==epoch||specialCancel!==cancellation)return;
        accept(data);manualPauseNeeded=false;pollFailures=0;showMessage('');
        settleSessionChange();render();
      }catch(error){
        if(!active||lease!==epoch||specialCancel!==cancellation)return;
        handleError(error);if(!active||lease!==epoch||specialCancel!==cancellation)return;
        cancellation.retryAt=Date.now()+Math.max(backoff(),error.status===429?error.retryAfterMs:0);
        cancellation.timer=setTimeout(()=>invalidateSpecial(),Math.max(0,cancellation.retryAt-Date.now()));render();
      }finally{
        cancellation.promise=null;
        if(active&&lease===epoch&&specialCancel===cancellation)afterRequest();
      }
    })();
  }
  function settleSessionChange(){
    if(!sessionChange)return;
    const guarded=pending?.autoSpecial&&pending.cancelled&&specialCancel?.confirmed;
    if(inFlight&&!guarded||pending&&!guarded||pauseOperation||manualPauseNeeded||specialBeat)return;
    if(run&&!terminal(run)&&run.status!=='paused')return;
    const change=sessionChange;sessionChange=null;clearTimeout(change.timer);change.resolve();
  }
  function prepareSessionChange(){
    if(answerPreview?.specialOwned)invalidateSpecial({force:true});
    clearPreview();clearSpecial();queuedAnswer=null;homeIntent=false;retryLevel=null;exitDestination='app';
    if(pending!==retryStart)retryStart=null;
    if(!active||(!run&&!pending)||(terminal(run)&&!pending)){if(active)render();return Promise.resolve();}
    if(sessionChange)return sessionChange.promise;
    let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
    const timer=setTimeout(()=>{if(sessionChange?.promise!==promise)return;sessionChange=null;reject(new Error('一時停止を確認できませんでした。もう一度お試しください。'));},20000);
    sessionChange={promise,resolve,reject,timer};requestPause();settleSessionChange();return promise;
  }
  function backoff(){return Math.min(15000,1200*2**Math.min(4,pollFailures));}
  function updateViewport(){
    if(!active||!document.body.classList.contains('challenge-is-game'))return;
    const height=Math.floor(Math.min(window.innerHeight,window.visualViewport?.height||window.innerHeight));
    document.body.style.setProperty('--challenge-viewport-height',height+'px');layoutSignature='';queueLayout();
  }
  function queueLayout(){
    if(layoutFrame!==null)return;
    layoutFrame=requestAnimationFrame(()=>{
      layoutFrame=null;if(!active||!document.body.classList.contains('challenge-is-game'))return;
      const root=$('challengeApp'),signature=[run?.question?.id,run?.status,pauseIntent,homeIntent,message,root.clientWidth,window.visualViewport?.height||innerHeight].join('|');
      if(signature===layoutSignature)return;
      root.classList.remove('is-compact','is-dense','has-overflow');
      if(root.scrollHeight>root.clientHeight+2)root.classList.add('is-compact');
      if(root.scrollHeight>root.clientHeight+2)root.classList.add('is-dense');
      // Future oversized content and accessibility zoom remain fully readable.
      if(root.scrollHeight>root.clientHeight+2)root.classList.add('has-overflow');
      layoutSignature=signature;
    });
  }
  function schedule(delay){
    clearTimeout(pollTimer);
    if(!active||specialBeat)return;
    const wait=delay??(pollFailures?backoff():run?.status==='playing'?650:run?.status==='paused'?8000:20000);
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
  function responseError(response,message,code){
    const error=new Error(message);error.status=response.status;error.code=code;
    if(response.status===429){
      const value=response.headers.get('Retry-After'),seconds=value&&/^\d+(?:\.\d+)?$/.test(value)?Number(value):NaN;
      const delay=Number.isFinite(seconds)?seconds*1000:value?Date.parse(value)-Date.now():NaN;
      error.retryAfterMs=Number.isFinite(delay)?Math.max(0,Math.min(86400000,delay)):60000;
    }
    return error;
  }
  async function api(action,body,{keepalive=false,controller=new AbortController()}={}){
    const timeout=setTimeout(()=>controller.abort(),12000);
    try{
      const response=await fetch('/api/challenge/'+action,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',redirect:'error',keepalive,
        headers:body===undefined?{Accept:'application/json'}:{Accept:'application/json','Content-Type':'application/json'},
        body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal});
      let data;try{data=await response.json();}catch(error){
        const failure=responseError(response,error.name==='AbortError'?'通信に時間がかかっています。':'サーバーの応答を確認できませんでした。');
        if(error.name==='AbortError'||error instanceof TypeError)failure.transient=true;
        throw failure;
      }
      if(!response.ok||data?.error)throw responseError(response,data?.error?.message||'接続を確認できませんでした。',data?.error?.code);
      if(data?.ok!==true)throw new Error('挑戦データを確認できませんでした。');
      return data;
    }catch(error){
      if(error.name==='AbortError'){const failure=new Error('通信に時間がかかっています。');failure.transient=true;throw failure;}
      if(error instanceof TypeError)error.transient=true;
      throw error;
    }
    finally{clearTimeout(timeout);}
  }
  function accept(data,{map=false}={}){
    if(map){
      if(!Array.isArray(data.levels)||data.levels.length!==10||data.levels.some((l,i)=>l?.level!==i+1||typeof l.unlocked!=='boolean'||typeof l.cleared!=='boolean'))throw new Error('ステージを確認できませんでした。');
      levels=data.levels;
      if(!run&&data.activeRun){run=checkRun(data.activeRun);mode='game';pauseIntent=true;}
    }else if(Object.hasOwn(data,'run'))run=checkRun(data.run);
    if(answerPreview&&!currentPreview(answerPreview))clearPreview();
    if(pauseIntent&&run?.status==='playing')run={...run,question:null};
    if(queuedAnswer&&(run?.status!=='playing'||run.id!==queuedAnswer.operation.body.runId||run.question?.id!==queuedAnswer.operation.body.questionId))queuedAnswer=null;
    if(data.wallet)callbacks.onWallet?.(data.wallet);
    if(terminal(run)){
      if(!homeIntent&&retryLevel===null)mode='result';
      pauseIntent=false;pauseOperation=null;pending=null;
      manualPauseNeeded=false;specialResume=null;
      if(!map&&run.status!=='aborted')mapNeeded=true;
    }
  }
  function handleError(error){
    if(error.status===401){const unauthorized=callbacks.onUnauthorized;close();unauthorized?.();return;}
    pollFailures++;
    showMessage(error.message+(homeIntent?' 終了の確認待ちです。':pauseIntent?' 停止の確認待ちです。':''));
  }
  async function refresh(){
    if(!active||inFlight||specialBeat||answerPreview)return;
    if(specialCancel){afterRequest();return;}
    if(pauseIntent&&['start','resume'].includes(pending?.action)&&!pending.autoSpecial){replayPending();return;}
    if(homeIntent&&pending?.action==='abort'){void perform(pending);return;}
    if(pauseIntent&&run&&(run.status==='playing'||manualPauseNeeded)){void confirmPause();return;}
    if(homeIntent&&(!run||terminal(run))&&!pending&&!pauseOperation){afterRequest();return;}
    if(pending===retryStart&&retryStart?.retryAt&&!document.hidden){replayPending();return;}
    if(pending===specialResume&&specialResume?.retryAt&&!document.hidden&&!pauseIntent&&!homeIntent){const delay=specialResume.retryAt-Date.now();if(delay>0)schedule(delay);else void perform(specialResume);return;}
    if(pending?.action==='answer'&&pending.retryAt&&!document.hidden&&!pauseIntent&&!homeIntent&&run?.status==='playing'&&
      run.id===pending.body.runId&&run.question?.id===pending.body.questionId){
      const delay=pending.retryAt-Date.now();if(delay>0){schedule(delay);return;}
      void perform(pending);return;
    }
    if(pending||pauseOperation){schedule();return;}
    if(document.hidden){schedule();return;}
    if(terminal(run)&&!mapNeeded)return;
    const lease=epoch,useMap=mode==='map'||mapNeeded||!run;
    inFlight=true;readInFlight=true;
    try{
      const data=await api(useMap?'map':'state?runId='+encodeURIComponent(run.id));
      if(!active||lease!==epoch)return;
      if(useMap)mapNeeded=false;
      canonicalNeeded=false;
      accept(data,{map:useMap});pollFailures=0;showMessage('');
    }catch(error){if(active&&lease===epoch)handleError(error);}
    finally{if(active&&lease===epoch){inFlight=false;readInFlight=false;render();afterRequest();}}
  }
  function afterRequest(){
    if(!active||inFlight||specialBeat||answerPreview)return;
    if(specialCancel){
      if(!specialCancel.confirmed){if(!specialCancel.promise)invalidateSpecial();return;}
      clearTimeout(specialCancel.timer);if(pending?.autoSpecial)pending=null;specialResume=null;specialCancel=null;manualPauseNeeded=false;render();
    }
    settleSessionChange();
    // Resolve an uncertain start/resume receipt before pausing. A delayed
    // original must not arrive after our pause and restart the clock offscreen.
    if(pauseIntent&&['start','resume'].includes(pending?.action)&&!pending.autoSpecial){if(pollFailures)schedule(Math.max(backoff(),(pending.retryAt||0)-Date.now()));else replayPending();return;}
    if(homeIntent&&pending?.action==='abort'){if(pollFailures)schedule();else void perform(pending);return;}
    if(pauseIntent&&run&&(run.status==='playing'||manualPauseNeeded)){if(pauseOperation&&pollFailures)schedule();else void confirmPause();return;}
    if(homeIntent&&run?.status==='paused'&&!pending&&!pauseOperation){void perform({action:'abort',body:{requestId:uuid(),runId:run.id}});return;}
    if(homeIntent&&(!run||terminal(run))&&!pending&&!pauseOperation){finishExit();return;}
    if(pending===retryStart&&retryStart?.retryAt){schedule(Math.max(0,retryStart.retryAt-Date.now()));return;}
    if(pending===specialResume&&specialResume?.retryAt){schedule(Math.max(0,specialResume.retryAt-Date.now()));return;}
    if(pending?.action==='answer'&&pending.retryAt){schedule(Math.max(0,pending.retryAt-Date.now()));return;}
    if(queuedAnswer){
      const queued=queuedAnswer,fields=queued.operation.body;queuedAnswer=null;
      if(queued.epoch===epoch&&!pauseIntent&&!homeIntent&&!pending&&!pauseOperation&&run?.status==='playing'&&
        run.id===fields.runId&&run.question?.id===fields.questionId&&run.question.choices.some(choice=>choice.id===fields.choiceId)){
        void perform(queued.operation);return;
      }
      render();
    }
    if(canonicalNeeded&&!pending&&!pauseOperation){schedule(pollFailures?backoff():0);return;}
    if(mapNeeded&&!pending&&!pauseOperation){schedule(0);return;}
    schedule();
  }
  function replayPending(){
    if(!pending)return;
    const delay=pending===retryStart?(pending.retryAt||0)-Date.now():0;
    if(delay>0){schedule(delay);return;}
    void perform(pending);
  }
  function finishExit(){
    if(exitDestination==='retry'&&retryLevel!==null){
      if(document.hidden){schedule();return;}
      retryStart??={action:'start',body:{requestId:uuid(),level:retryLevel}};
      homeIntent=false;pauseIntent=false;mode='game';mapNeeded=false;
      void perform(retryStart);return;
    }
    if(exitDestination==='map'){
      homeIntent=false;exitDestination='app';retryLevel=null;retryStart=null;
      backToMap();window.scrollTo({top:0,behavior:'instant'});return;
    }
    const go=callbacks.onHome;close();go?.();
  }
  async function perform(operation){
    if(!active||inFlight)return;
    inFlight=true;readInFlight=false;clearTimeout(pollTimer);const lease=epoch;
    if(operation.action==='start')specialFinishRunId=null;
    if(operation.action==='answer'||operation===retryStart||operation.autoSpecial){delete operation.retryAt;delete operation.rateLimitedUntil;}
    if(operation.autoSpecial)operation.controller=new AbortController();
    if(operation.action!=='pause')pending=operation;
    render();
    try{
      const data=await api(operation.action,operation.body,{keepalive:['pause','abort'].includes(operation.action),...(operation.autoSpecial?{controller:operation.controller}:{})});
      if(!active||lease!==epoch)return;
      if(operation.autoSpecial&&operation.cancelled){if(pending===operation)pending=null;specialResume=null;canonicalNeeded=true;return;}
      if(operation.action==='abort'&&!terminal(checkRun(data.run)))throw new Error('終了状態を確認できませんでした。');
      if(operation===retryStart){const next=checkRun(data.run);if(!next||next.level!==operation.body.level||next.id===run?.id)throw new Error('リトライを確認できませんでした。');}
      if(operation.action==='pause'){pauseOperation=null;pending=null;manualPauseNeeded=false;specialResume=null;}
      else pending=null;
      if(operation.action==='resume')drawnQuestion=null;
      if(operation.autoSpecial)specialResume=null;
      if(operation.action==='start'){clearSpecial();specialFinishRunId=null;mode='game';feedback='';drawnMode='';}
      if(operation===retryStart){retryStart=null;retryLevel=null;lastHp=null;if(!homeIntent)exitDestination='app';}
      accept(data);pollFailures=0;showMessage('');
      if(operation.action==='answer'&&data.answer){
        const a=data.answer,previewed=beginPreview(operation,data),freshSpecial=previewed?false:specialHit(operation,data);
        if(a.specialAttack===true&&run?.status==='won'&&run.id===operation.body.runId&&Number.isSafeInteger(data.reward)&&data.reward>0)specialFinishRunId=run.id;
        feedback=a.specialAttack===true?(freshSpecial?'必殺 · −'+a.specialDamage:''):a.correct?(a.streakBonus?'5 COMBO · HP +'+(a.healedHp||0):'GOOD · −5'):'MISS · HP −10';
        clearTimeout(feedbackTimer);feedbackTimer=setTimeout(()=>{feedback='';const node=$('challengeFeedback');if(node)node.textContent='';},1000);
      }
    }catch(error){
      if(active&&lease===epoch){
        if(operation.autoSpecial&&operation.cancelled){if(pending===operation)pending=null;specialResume=null;canonicalNeeded=true;return;}
        if(operation.action!=='abort'&&[400,404,409].includes(error.status)){
          if(operation.action==='pause')pauseOperation=null;else pending=null;
          // Read the authoritative question after an already accepted answer.
          if(operation.action==='answer'){drawnQuestion=null;if(run?.status==='playing')run={...run,question:null};}
          if(operation.action==='start'){run=null;mapNeeded=true;}
          if(operation===retryStart){retryStart=null;retryLevel=null;homeIntent=true;exitDestination='map';}
          if(operation.autoSpecial){specialResume=null;canonicalNeeded=true;}
        }
        handleError(error);
        if(operation.autoSpecial&&error.status===409)pollFailures=0;
        if(active&&lease===epoch&&pending===operation&&(operation.action==='answer'||operation===retryStart||operation.autoSpecial)&&
          (error.status===503||error.status===429||error.transient===true)){
          operation.retryAt=Date.now()+Math.max(backoff(),error.status===429?error.retryAfterMs:0);
          if(error.status===429)operation.rateLimitedUntil=operation.retryAt;
        }
      }
    }finally{if(active&&lease===epoch){inFlight=false;render();afterRequest();}}
  }
  function start(level){
    if(!active||specialBeat||inFlight||pending||homeIntent||!levels.some(l=>l.level===level&&l.unlocked))return;
    pauseIntent=false;homeIntent=false;void perform({action:'start',body:{requestId:uuid(),level}});
  }
  function answer(questionId,choiceId){
    if(!active||answerPreview||specialBeat||pending||queuedAnswer||pauseIntent||homeIntent||retryLevel!==null||run?.status!=='playing'||run.question?.id!==questionId||
      !run.question.choices.some(choice=>choice.id===choiceId)||inFlight&&!readInFlight)return;
    const operation={action:'answer',body:{requestId:uuid(),runId:run.id,questionId,choiceId},capture:{count:answerCount(run),question:{...run.question,choices:run.question.choices.map(choice=>({...choice}))}}};
    if(readInFlight){queuedAnswer={operation,epoch};render();return;}
    void perform(operation);
  }
  function requestPause(){
    if(specialBeat||specialResume||specialCancel||answerPreview?.specialOwned)invalidateSpecial({force:true});
    clearPreview();
    clearSpecial();
    queuedAnswer=null;
    if(!active)return;
    if(terminal(run)&&pending?.action!=='start'&&retryLevel===null){render();afterRequest();return;}
    pauseIntent=true;manualPauseNeeded=!specialCancel?.confirmed;feedback='';drawnQuestion=null;
    if(run)run={...run,question:null};
    render();
    if(!inFlight){if(specialCancel)afterRequest();else if(['start','resume'].includes(pending?.action)&&!pending.autoSpecial)replayPending();else void confirmPause();}
  }
  function confirmPause(){
    if(!active||inFlight||!run||run.status!=='playing'&&!manualPauseNeeded||pending?.action==='resume'&&!pending.autoSpecial)return;
    if(!pauseOperation)pauseOperation={action:'pause',body:{requestId:uuid(),runId:run.id}};
    return perform(pauseOperation);
  }
  function resume(){
    if(specialBeat){requestPause();return;}
    if(specialCancel){invalidateSpecial();return;}
    if(inFlight||!active)return;
    if(homeIntent||retryLevel!==null){retry();return;}
    if(pauseOperation){void perform(pauseOperation);return;}
    if(pauseIntent&&run?.status==='playing'){void confirmPause();return;}
    if(pending){if(pending.action==='resume')pauseIntent=false;void perform(pending);return;}
    if(run?.status==='paused'){pauseIntent=false;void perform({action:'resume',body:{requestId:uuid(),runId:run.id}});}
  }
  function leaveHome(){beginExit('app');}
  function leaveMap(){beginExit('map');}
  function restart(){if(!active||homeIntent||retryLevel!==null||!run)return;beginExit('retry',run.level);}
  function beginExit(destination,level=null){
    if(!active)return;
    if(specialBeat||specialResume||specialCancel||answerPreview?.specialOwned)invalidateSpecial({force:true});
    clearPreview();
    clearSpecial();specialFinishRunId=null;
    if(pending?.autoSpecial){pauseIntent=true;manualPauseNeeded=true;}
    exitDestination=destination;retryLevel=destination==='retry'?level:null;
    homeIntent=true;queuedAnswer=null;
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
    clearPreview();
    specialFinishRunId=null;
    run=null;mode='map';pauseIntent=false;pauseOperation=null;feedback='';drawnMode='';mapNeeded=true;
    render();void refresh();
  }
  function retry(){if(specialCancel){invalidateSpecial();return;}if(inFlight)return;if(pauseOperation)void perform(pauseOperation);else if(pending){if(pending.rateLimitedUntil>Date.now()){schedule(pending.rateLimitedUntil-Date.now());return;}void perform(pending);}else if(homeIntent)afterRequest();else if(pauseIntent)void confirmPause();else void refresh();}

  function shell(){
    const root=$('challengeApp');root.replaceChildren();
    const status=make('p','challenge-status',message);status.id='challengeStatus';status.setAttribute('role','status');status.setAttribute('aria-live','polite');status.hidden=!message;
    root.append(status);
    return root;
  }
  function renderMap(){
    const existing=drawnMode==='map'&&$('challengeMap');
    const anchor=existing?[...document.querySelectorAll('.challenge-tile,.challenge-map-clearer-row')].find(node=>{const rect=node.getBoundingClientRect();return rect.bottom>0&&rect.top<innerHeight;}):null;
    const anchorTop=anchor?.getBoundingClientRect().top;
    const root=existing?$('challengeApp'):shell();
    if(!existing){
      const header=make('div','challenge-map-header'),copy=make('div');copy.append(make('h1','','挑戦'));
      header.append(copy,button('ホーム','challenge-nav',()=>leaveHome()));root.prepend(header);
      const grid=make('div','challenge-map');grid.id='challengeMap';grid.setAttribute('aria-label','挑戦ステージ');root.append(grid);
      const loading=make('div','challenge-loading','ステージを読み込み中…');loading.id='challengeMapLoading';root.append(loading);
      const clearers=make('section','challenge-map-clearers');clearers.id='challengeMapClearers';
      const title=make('h2','','攻略者');title.id='challengeMapClearersTitle';clearers.setAttribute('aria-labelledby',title.id);clearers.append(title);
      const list=make('ol','challenge-map-clearer-list');
      for(let level=1;level<=10;level++){
        const row=make('li','challenge-map-clearer-row');row.dataset.level=String(level);
        const names=make('div','challenge-map-clearer-names');names.id='challengeMapClearers'+level;
        row.append(make('h3','','Lv.'+level),names);list.append(row);
      }
      clearers.append(list);root.append(clearers);
      const retryButton=button('再接続','secondary-button challenge-retry',retry);retryButton.id='challengeMapRetry';root.append(retryButton);
    }
    const grid=$('challengeMap');
    for(const entry of levels){
      const level=entry.level;
      let tile=grid.querySelector('[data-level="'+level+'"]');
      if(!tile){tile=button('','challenge-tile',()=>start(level));tile.dataset.level=String(level);grid.append(tile);}
      tile.disabled=!entry.unlocked||inFlight||!!pending;
      tile.setAttribute('aria-label','Lv.'+level+' '+titles[level-1]+(!entry.unlocked?' ロック中':entry.cleared?' クリア済み':''));
      const state=entry.unlocked+':'+entry.cleared;
      if(tile.dataset.state!==state){
        tile.dataset.state=state;tile.classList.toggle('is-cleared',entry.cleared);tile.classList.toggle('is-locked',!entry.unlocked);
        const image=make('span','challenge-tile-art');scene(image,level);image.append(make('span','challenge-tile-level','Lv. '+level));
        if(entry.cleared)image.append(svgNode('badgeSVG',level,'challenge-tile-badge'));
        if(!entry.unlocked)image.append(make('span','challenge-lock','♜'));
        const copy=make('span','challenge-tile-copy');copy.append(make('strong','',titles[level-1]),make('span','challenge-tile-reward',(level*100000).toLocaleString('ja-JP')+'轟'));
        if(entry.cleared)copy.append(make('span','challenge-clear-check','✓ CLEAR'));
        tile.replaceChildren(image,copy);
      }
      const names=$('challengeMapClearers'+level),clearerNames=namesForLevel(level),key=JSON.stringify(clearerNames);
      if(names.dataset.names!==key){names.dataset.names=key;renderNames(names,clearerNames);}
    }
    $('challengeMapLoading').hidden=levels.length>0;$('challengeMapClearers').hidden=!levels.length;
    $('challengeMapRetry').hidden=!pending&&!message;$('challengeMapRetry').textContent=pending?'もう一度確認':'再接続';
    if(anchor?.isConnected){const drift=anchor.getBoundingClientRect().top-anchorTop;if(Math.abs(drift)>1)window.scrollBy({top:drift,behavior:'instant'});}
  }
  function hp(role,label,value,max){
    const box=make('div','challenge-health challenge-health-'+role),heading=make('div','challenge-health-label');
    heading.append(make('strong','',label));
    if(role==='player'){
      const count=Number.isSafeInteger(run?.streak)&&run.streak>=0?run.streak:null;
      const tier=count===null||count<5?0:count<10?1:count<20?2:count<30?3:count<40?4:5;
      const chip=make('span','challenge-streak-chip streak-tier-'+tier,(count===null?'—':count)+'連続');chip.id='challengeStreak';chip.dataset.tier=String(tier);heading.append(chip);
    }
    heading.append(make('span','',value+' / '+max));
    const track=make('div','challenge-health-track'),fill=make('span');fill.style.width=(value/max*100)+'%';track.append(fill);
    track.setAttribute('role','progressbar');track.setAttribute('aria-label',label+' HP');track.setAttribute('aria-valuemin','0');track.setAttribute('aria-valuemax',String(max));track.setAttribute('aria-valuenow',String(value));
    box.append(heading,track);return box;
  }
  function buildGame(){
    clearSpecial();
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
  function wireChoice(option,viewport,questionId,choiceId){
    let gesture=null,dragged=false;
    const moved=event=>gesture&&(Math.abs(event.clientX-gesture.x)>7||Math.abs(event.clientY-gesture.y)>7||Math.abs(viewport.scrollLeft-gesture.scroll)>2);
    option.addEventListener('pointerdown',event=>{
      if(event.isPrimary===false||event.button!==0)return;
      dragged=false;gesture={id:event.pointerId,x:event.clientX,y:event.clientY,scroll:viewport.scrollLeft,mouse:event.pointerType==='mouse',pan:viewport.contains(event.target)&&viewport.scrollWidth>viewport.clientWidth+1};
      if(gesture.mouse&&gesture.pan)try{option.setPointerCapture(event.pointerId);}catch{}
    });
    option.addEventListener('pointermove',event=>{
      if(!gesture||gesture.id!==event.pointerId)return;
      if(moved(event))dragged=true;
      if(dragged&&gesture.mouse&&gesture.pan){viewport.scrollLeft=gesture.scroll-(event.clientX-gesture.x);event.preventDefault();}
    });
    option.addEventListener('pointerup',event=>{if(gesture?.id===event.pointerId){if(moved(event))dragged=true;gesture=null;}});
    option.addEventListener('pointercancel',()=>{dragged=true;gesture=null;});
    viewport.addEventListener('scroll',()=>{if(gesture&&Math.abs(viewport.scrollLeft-gesture.scroll)>2)dragged=true;});
    option.addEventListener('click',event=>{
      if(event.detail!==0&&dragged){event.preventDefault();event.stopPropagation();return;}
      answer(questionId,choiceId);
    });
    option.addEventListener('keydown',event=>{
      if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)||viewport.scrollWidth<=viewport.clientWidth+1)return;
      event.preventDefault();
      if(event.key==='Home'||event.key==='End')viewport.scrollLeft=event.key==='Home'?0:viewport.scrollWidth;
      else viewport.scrollLeft+=(event.key==='ArrowRight'?1:-1)*(viewport.clientWidth+12);
    });
  }
  function renderQuestion(){
    const region=$('challengeQuestionRegion'),paused=pauseIntent||run.status==='paused'||homeIntent||retryLevel!==null||!!specialBeat;
    if(paused&&!answerPreview){
      // Remove the question and choices at once. The opaque panel never relies on blur.
      region.replaceChildren();drawnQuestion=null;region.classList.add('is-paused');
      const panel=make('div','challenge-pause-panel');panel.setAttribute('role','group');panel.setAttribute('aria-label','一時停止');
      const confirmed=run.status==='paused'&&!pauseOperation&&!manualPauseNeeded&&!specialCancel;
      const transitioning=homeIntent||retryLevel!==null;
      panel.append(make('h2','',retryLevel!==null?'リトライを確認中…':homeIntent?'終了を確認中…':confirmed?'PAUSED':'停止を確認中…'));
      const next=button(transitioning||specialCancel?'再接続':confirmed?'続ける':pauseOperation&&!inFlight?'再接続':'続ける','primary-button',transitioning||specialCancel?retry:resume);
      next.id='challengeResume';next.disabled=inFlight||!!specialCancel?.promise||!transitioning&&!confirmed&&!pauseOperation&&!specialCancel;
      const again=button('リトライ','secondary-button',restart);again.id='challengeRestart';again.disabled=inFlight||transitioning;
      const homeButton=button('ホーム','secondary-button',leaveMap);homeButton.id='challengeHome';homeButton.disabled=inFlight;
      panel.append(next,again,homeButton);region.append(panel);return;
    }
    region.classList.remove('is-paused');
    const question=answerPreview?.question||run.question;
    if(drawnQuestion!==question?.id){
      region.replaceChildren();drawnQuestion=question?.id||null;
      if(!question){region.append(make('div','challenge-question-loading','次の問題を準備中…'));return;}
      const prompt=make('h2','challenge-prompt',question.prompt);prompt.id='challengePrompt';
      const choices=make('div','challenge-choices');
      for(const [index,choice]of question.choices.entries()){
        const option=make('button','challenge-choice');option.type='button';option.dataset.choice=choice.id;option.setAttribute('aria-label',choice.text);
        const text=make('span','challenge-choice-text'),track=make('span','challenge-choice-track',choice.text);text.append(track);
        option.append(make('span','challenge-choice-letter','ABCD'[index]),text);wireChoice(option,text,question.id,choice.id);choices.append(option);
      }
      region.append(prompt,choices);
    }
    for(const option of region.querySelectorAll('.challenge-choice')){
      const id=option.dataset.choice,green=!!answerPreview&&id===answerPreview.correctId,red=!!answerPreview&&!answerPreview.correct&&id===answerPreview.chosen;
      option.classList.toggle('is-answer-correct',green);option.classList.toggle('is-answer-wrong',red);
      const text=question?.choices.find(choice=>choice.id===id)?.text;if(text!==undefined)option.setAttribute('aria-label',text+(green?'（正解）':red?'（不正解）':''));
      option.disabled=!!answerPreview||inFlight&&!readInFlight||!!pending||!!queuedAnswer;
    }
    region.querySelector('.challenge-answer-retry')?.remove();
    if(pending&&!inFlight){const retryButton=button('同じ回答を確認','secondary-button challenge-answer-retry',retry);retryButton.disabled=pending.rateLimitedUntil>Date.now();region.append(retryButton);}
  }
  function renderGame(){
    if(drawnMode!=='game'){buildGame();updateViewport();}
    const background=art('sceneURL',run.level);
    if(background)document.body.style.setProperty('--challenge-scene','url("'+background.replace(/"/g,'%22')+'")');
    $('challengeEnemyHealth').replaceChildren(hp('enemy',mobs[run.level-1],run.enemyHp,run.enemyMaxHp));
    $('challengePlayerHealth').replaceChildren(hp('player',identity.name||'YOU',run.playerHp,run.playerMaxHp));
    const previous=lastHp;
    if(previous&&previous.enemy>run.enemyHp){$('challengeMob').classList.remove('is-hit');void $('challengeMob').offsetWidth;$('challengeMob').classList.add('is-hit');}
    if(previous&&previous.player>run.playerHp){$('challengeArena').classList.remove('is-damaged');void $('challengeArena').offsetWidth;$('challengeArena').classList.add('is-damaged');}
    lastHp={player:run.playerHp,enemy:run.enemyHp};
    $('challengePause').disabled=pauseIntent||run.status==='paused'&&!answerPreview||homeIntent||retryLevel!==null;
    renderQuestion();$('challengeFeedback').textContent=pauseIntent?'':feedback;
    $('challengeStrike').style.setProperty('--attack-progress',String(Math.max(0,Math.min(1,(run.nextAttackInMs||0)/(run.attackIntervalMs||3000)))));
    queueLayout();
  }
  function namesForLevel(level){
    const names=levels.find(entry=>entry.level===level)?.clearers;
    return [...new Set((Array.isArray(names)?names:[]).map(value=>typeof value==='string'?value:typeof value?.name==='string'?value.name:'').map(value=>value.trim()).filter(Boolean))];
  }
  function renderNames(root,names,empty='まだいません'){
    root.replaceChildren();
    if(!names.length){root.append(make('p','',empty));return;}
    const list=make('ul');for(const name of names)list.append(make('li','',name));root.append(list);
  }
  function renderClearers(root){
    const names=namesForLevel(run.level);
    const section=make('section','challenge-clearers');section.append(make('h2','','このレベルのクリア達成者'));
    const content=make('div','challenge-clearer-content');renderNames(content,names,mapNeeded?'確認中…':'まだいません');section.append(content);
    root.append(section);
  }
  function renderResult(){
    const root=shell(),won=run.status==='won',level=run.level;
    const panel=make('div','challenge-result '+(won?'is-victory':'is-defeat'));
    const artNode=make('div','challenge-result-scene');scene(artNode,level);artNode.append(svgNode(won?'badgeSVG':'mobSVG',level,'challenge-result-art'));panel.append(artNode);
    const copy=make('div','challenge-result-copy');copy.append(make('span','challenge-eyebrow','LEVEL '+String(level).padStart(2,'0')),make('h1','',won?'VICTORY!':'DEFEAT'));
    if(won){const note=make('p','challenge-result-note','お見事！');if(specialFinishRunId===run.id)note.append(make('span','challenge-special-finish','必殺'));copy.append(note);}
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
    if(terminal(run)&&!answerPreview&&!specialBeat&&!homeIntent&&retryLevel===null)mode='result';
    const next=mode==='game'&&run?'game':mode==='result'&&run?'result':'map';
    document.body.classList.toggle('challenge-is-game',next==='game');
    if(next!=='game'){clearSpecial();document.body.style.removeProperty('--challenge-scene');document.body.style.removeProperty('--challenge-viewport-height');$('challengeApp').classList.remove('is-compact','is-dense','has-overflow');layoutSignature='';}
    if(next==='game')renderGame();else if(next==='result')renderResult();else renderMap();
    drawnMode=next;showMessage(message);
  }
  function close(){
    if(active&&(specialBeat||specialResume||specialCancel||answerPreview?.specialOwned))invalidateSpecial({force:true});
    if(sessionChange){const change=sessionChange;sessionChange=null;clearTimeout(change.timer);if(!inFlight&&!pending&&!manualPauseNeeded&&(!run||terminal(run)||run.status==='paused'))change.resolve();else change.reject(new Error('一時停止を確認できませんでした。もう一度お試しください。'));}
    if(specialCancel)clearTimeout(specialCancel.timer);
    active=false;epoch++;clearTimers();shownSpecials.clear();shownPreviews.clear();specialFinishRunId=null;specialResume=null;specialCancel=null;manualPauseNeeded=false;canonicalNeeded=false;callbacks={};identity=null;levels=[];run=null;queuedAnswer=null;pending=null;pauseOperation=null;pauseIntent=false;homeIntent=false;exitDestination='app';retryLevel=null;retryStart=null;
    inFlight=false;readInFlight=false;mode='map';mapNeeded=false;pollFailures=0;message='';feedback='';drawnMode='';drawnQuestion=null;lastHp=null;layoutSignature='';
    document.body.classList.remove('challenge-is-game');document.body.style.removeProperty('--challenge-scene');document.body.style.removeProperty('--challenge-viewport-height');$('challengeApp')?.classList.remove('is-compact','is-dense','has-overflow');$('challengeApp')?.replaceChildren();
  }
  function open(member,options={}){
    close();if(!validId(member?.id)||typeof member.name!=='string')return;
    identity={id:member.id,name:member.name};callbacks=options;active=true;render();void refresh();
  }
  document.addEventListener('visibilitychange',()=>{
    if(!active)return;
    if(document.hidden){if(answerPreview||specialBeat||specialResume||run?.status==='playing'||inFlight&&mode==='map'||['start','resume'].includes(pending?.action))requestPause();}
    else if(pauseOperation)void retry();else if(pauseIntent&&run?.status==='playing')void confirmPause();else void refresh();
  });
  window.addEventListener('pagehide',()=>{if(active&&(answerPreview||specialBeat||specialResume||run?.status==='playing'))requestPause();});
  window.addEventListener('resize',updateViewport);window.visualViewport?.addEventListener('resize',updateViewport);
  window.TargetChallengeUI={open,close,leaveHome,refresh,prepareSessionChange};
})();
