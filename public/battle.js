'use strict';
(() => {
  const books={target1900:['Target 1900',19],target1000:['英熟語 Target 1000',10],kobun400:['古文単語',4]};
  const $=id=>document.getElementById(id);
  const make=(tag,cls,label)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(label!==undefined)n.textContent=String(label);return n;};
  const money=n=>Number.isSafeInteger(n)?n.toLocaleString('ja-JP')+'轟':'—';
  const validId=id=>typeof id==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id);
  const first=name=>[...String(name||'?')][0];
  const freshId=()=>crypto.randomUUID();
  let active=false,identity=null,epoch=0,syncRevision=0,timer=null,fetching=false,busy=false,matchId=null,match=null,clockOffset=0,lastLobbyPoll=0;
  let online=[],ranking=[],incoming=[],outgoing=[],selected=null,offerVersion=null,questionId=null,pendingAnswer=null,feedback='',shownStampKey=null;
  function status(message,error=false){const el=$('battleStatus');if(el){el.textContent=message;el.classList.toggle('is-error',error);}}
  async function api(action,body){
    const sentAt=Date.now();
    const controller=new AbortController(),t=setTimeout(()=>controller.abort(),14000);
    try{
      const response=await fetch('/api/battle/'+action,{method:body===undefined?'GET':'POST',
        credentials:'same-origin',cache:'no-store',redirect:'error',
        headers:body===undefined?{'Accept':'application/json'}:{'Accept':'application/json','Content-Type':'application/json'},
        body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal});
      let data;try{data=await response.json();}catch{throw new Error('サーバーの応答を確認できませんでした。');}
      if(!response.ok||data?.error){
        const failure=new Error(data?.error?.message||'サーバーへ接続できませんでした。');
        failure.code=data?.error?.code||'';
        failure.status=response.status;
        throw failure;
      }
      if(data?.ok!==true)throw new Error('対戦データを確認できませんでした。');
      const serverStamp=Number(response.headers.get('X-Target-Now'));
      if(Number.isFinite(serverStamp)&&serverStamp>0&&serverStamp<Date.now()+60000)
        clockOffset=serverStamp-(sentAt+Date.now())/2;
      return data;
    }catch(e){if(e.name==='AbortError')throw new Error('通信がタイムアウトしました。');throw e;}
    finally{clearTimeout(t);}
  }
  function selectOptions(el,items){
    el.replaceChildren();
    for(const [value,label] of items){const n=make('option','',label);n.value=String(value);el.append(n);}
  }
  function updateSections(reset){
    const count=books[$('battleBook').value]?.[1]||1;
    const from=$('battleFrom').value,to=$('battleTo').value;
    const items=Array.from({length:count},(_,i)=>[i+1,'Section '+(i+1)]);
    selectOptions($('battleFrom'),items);selectOptions($('battleTo'),items);
    $('battleFrom').value=!reset&&Number(from)<=count?from:'1';
    $('battleTo').value=!reset&&Number(to)<=count&&Number(to)>=Number($('battleFrom').value)?to:$('battleFrom').value;
  }
  function params(){
    const book=$('battleBook').value,fromSection=Number($('battleFrom').value),
      toSection=Number($('battleTo').value),stakeText=$('battleStake').value,stake=Number(stakeText),initialHp=Number($('battleHp').value);
    if(!books[book]||fromSection<1||toSection<fromSection||toSection>books[book][1]||
      !Number.isInteger(fromSection)||!Number.isInteger(toSection)||
      !/^[0-9]{3,13}$/.test(stakeText)||!Number.isSafeInteger(stake)||stake<100||
      stake>5000000000000||stake%100!==0||![50,100,150,200,300].includes(initialHp))
      throw new Error('教材・Section・賭け金（100轟刻み）・初期HPを確認してください。');
    return {book,fromSection,toSection,stake,initialHp};
  }
  function fill(m){
    if(!books[m.book])return;
    $('battleBook').value=m.book;updateSections(true);
    $('battleFrom').value=String(m.fromSection);$('battleTo').value=String(m.toSection);
    $('battleStake').value=String(m.stake);$('battleHp').value=String(m.initialHp);
  }
  function potPreview(){
    const value=Number($('battleStake').value);
    $('battlePotPreview').textContent=Number.isSafeInteger(value)&&value>0&&value<=5000000000000?
      '合計 '+money(value*2)+'（1人 '+money(value)+'）':'賭け金は100轟単位';
  }
  function build(){
    $('battleApp').innerHTML=[
      "<p class='battle-intro'>同じ問題で早押し · 正解で相手 −5 HP / 誤答で自分 −10 HP</p>",
      "<p id='battleStatus' class='battle-status' role='status' aria-live='polite'></p>",
      "<section id='battleLobby'>",
      "<div class='battle-heading battle-online-heading'><div class='battle-heading-title'><h2>ログイン中</h2><small id='battleOnlineCount' aria-live='polite'>—</small></div><button id='battleLobbyRefresh' class='battle-refresh' type='button' aria-label='ログイン中のユーザーとランキングを更新' title='更新'>↻</button></div>",
      "<div id='battleOnlineList' class='battle-people' aria-label='ログイン中のユーザー一覧'></div>",
      "<p id='battleOnlineEmpty' class='battle-intro' hidden>ほかのオンラインユーザーはいません。</p>",
      "<div id='battleInvitations' hidden><h2>届いた招待</h2><div id='battleIncomingList'></div></div>",
      "<div id='battleSentInvitations' hidden><h2>送信中の招待</h2><div id='battleOutgoingList'></div></div>",
      "<section id='battleRankingPanel' class='battle-ranking-panel' aria-labelledby='battleRankingTitle'>",
      "<div class='battle-heading battle-ranking-heading'><h2 id='battleRankingTitle'>ランキング</h2><span>勝利回数順</span></div>",
      "<div id='battleRankingList' class='battle-ranking-list' role='list' aria-label='リアタイバトル勝利回数ランキング'></div>",
      "<p id='battleRankingEmpty' class='battle-intro' hidden>まだ勝利記録はありません。</p></section>",
      "</section>",
      "<section id='battleOffer' class='battle-box' hidden>",
      "<h2 id='battleOfferTitle'>対戦設定</h2><p id='battleOfferSub' class='battle-intro'></p>",
      "<form id='battleOfferForm' class='battle-form'>",
      "<label>出題教材<select id='battleBook'></select></label>",
      "<div class='battle-range'><label>開始Section<select id='battleFrom'></select></label><label>終了Section<select id='battleTo'></select></label></div>",
      "<label>1人あたりの賭け金（轟）<input id='battleStake' type='number' inputmode='numeric' min='100' max='5000000000000' step='100' value='100' required></label>",
      "<label>初期HP<select id='battleHp'></select></label>",
      "<p id='battlePotPreview' class='battle-pot-preview'></p>",
      "<button id='battleSendOffer' class='primary-button wide' type='submit'>対戦を申し込む</button></form>",
      "<div id='battleApprovalsBlock' hidden><p id='battleApprovals' class='battle-intro'></p>",
      "<button id='battleReady' class='primary-button wide' type='button'>この条件で承認</button>",
      "<p class='battle-caution'>両者が承認するまで賭け金は確保されません。条件を変更すると双方の承認が解除されます。</p></div>",
      "<button id='battleOfferBack' class='text-button' type='button'>戻る</button></section>",
      "<section id='battleGame' hidden>",
      "<div class='battle-board'><div class='battle-names'><strong id='battleHostName'></strong>",
      "<span class='battle-pot'><small>合計賭け金</small><strong id='battleTotalStake'></strong></span>",
      "<strong id='battleGuestName'></strong></div>",
      "<div class='battle-bars'><div class='battle-half battle-left'><span id='battleHostFill'></span></div>",
      "<span class='battle-mid' aria-hidden='true'></span>",
      "<div class='battle-half battle-right'><span id='battleGuestFill'></span></div></div>",
      "<div class='battle-avatars'><div><span class='battle-avatar' id='battleHostAvatar'></span><b id='battleHostHP'></b></div>",
      "<div><span class='battle-avatar' id='battleGuestAvatar'></span><b id='battleGuestHP'></b></div></div></div>",
      "<div id='battleQuestionBlock' class='battle-question'><small id='battleQuestionMeta'></small><h2 id='battlePrompt'></h2>",
      "<div class='battle-choice-stage'><div id='battleHitStamp' class='battle-hit-stamp' role='status' aria-live='polite' hidden></div>",
      "<div id='battleChoices' class='battle-choices'></div></div></div>",
      "<p id='battleFeedback' class='battle-feedback' role='status'></p>",
      "<button id='battleAnswerRetry' class='secondary-button wide' type='button' hidden>同じ回答を再確認</button>",
      "<button id='battleForfeit' class='text-button battle-forfeit' type='button'>降参する</button></section>",
      "<section id='battleDone' class='battle-box' hidden><h2 id='battleDoneTitle'></h2>",
      "<p id='battleDoneMessage'></p><button id='battleAgain' class='primary-button wide' type='button'>別の対戦相手を探す</button></section>"
    ].join('');
    selectOptions($('battleBook'),Object.entries(books).map(([key,value])=>[key,value[0]]));
    $('battleBook').value=books[$('bookSelect')?.value]?$('bookSelect').value:'target1900';
    selectOptions($('battleHp'),[50,100,150,200,300].map(n=>[n,n+' HP']));$('battleHp').value='100';
    updateSections(true);potPreview();
    $('battleBook').addEventListener('change',()=>updateSections(true));
    $('battleStake').addEventListener('input',potPreview);
    for(const [a,b] of [['battleFrom','battleTo'],['battleTo','battleFrom']]){
      $(a).addEventListener('change',()=>{if(Number($('battleFrom').value)>Number($('battleTo').value))$(b).value=$(a).value;});
    }
    $('battleOfferForm').addEventListener('submit',event=>{event.preventDefault();void submitOffer();});
    $('battleReady').addEventListener('click',()=>void approve());
    $('battleOfferBack').addEventListener('click',()=>void cancelOffer());
    $('battleForfeit').addEventListener('click',()=>void forfeit());
    $('battleAnswerRetry').addEventListener('click',()=>void submitAnswer());
    $('battleAgain').addEventListener('click',()=>{matchId=null;match=null;selected=null;offerVersion=null;render();void refresh();});
    $('battleLobbyRefresh').addEventListener('click',()=>void refresh());
    $('battleOnlineList').addEventListener('click',event=>{
      const id=event.target.closest('[data-person]')?.dataset.person;
      if(!validId(id)||busy||!online.some(person=>person.id===id))return;
      // Invitations contain no game settings. Both players negotiate them after acceptance.
      void mutate('challenge',{targetId:id});
    });
    $('battleIncomingList').addEventListener('click',event=>{
      const button=event.target.closest('[data-invitation]');if(!button)return;
      const action=button.dataset.action,id=button.dataset.invitation;
      if(['accept','decline'].includes(action)&&validId(id))void mutate(action,{matchId:id});
    });
    $('battleOutgoingList').addEventListener('click',event=>{
      const id=event.target.closest('[data-sent]')?.dataset.sent;
      if(validId(id))void mutate('cancel',{matchId:id});
    });
  }
  function person(person,selectable){
    const row=make('div','battle-person');
    const dot=make('span','battle-online-dot');
    dot.setAttribute('aria-hidden','true');
    row.append(dot,make('strong','battle-online-name',person.name));
    if(selectable){
      const b=make('button','secondary-button','対戦する');
      b.type='button';b.dataset.person=person.id;row.append(b);
    }else{
      row.classList.add('is-self');
      row.append(make('span','battle-self-label','自分'));
    }
    return row;
  }
  function renderRanking(){
    const list=$('battleRankingList');
    list.replaceChildren();
    for(const entry of ranking){
      if(!entry||!validId(entry.id)||typeof entry.name!=='string'||
        !Number.isSafeInteger(entry.wins)||entry.wins<0||
        !Number.isSafeInteger(entry.rank)||entry.rank<1)continue;
      const row=make('div','battle-ranking-row');
      row.setAttribute('role','listitem');
      if(entry.id===identity?.id)row.classList.add('is-self');
      row.append(make('span','battle-ranking-place',entry.rank),
        make('strong','battle-ranking-name',entry.name),
        make('span','battle-ranking-wins',entry.wins+'勝'));
      list.append(row);
    }
    $('battleRankingEmpty').hidden=list.childElementCount>0;
  }
  function renderLobby(){
    const visible=online.filter(p=>p&&validId(p.id)&&p.id!==identity?.id&&typeof p.name==='string');
    $('battleOnlineCount').textContent=String(visible.length+1);
    $('battleOnlineList').replaceChildren(person(identity,false));
    for(const p of visible)$('battleOnlineList').append(person(p,true));
    $('battleOnlineEmpty').hidden=visible.length>0;
    renderRanking();
    $('battleInvitations').hidden=!incoming.length;$('battleIncomingList').replaceChildren();
    for(const m of incoming){
      if(!validId(m?.id))continue;
      const card=make('div','battle-invite');card.append(make('strong','',m.host?.name||'招待'),
        make('p','battle-intro','対戦に招待されています。承認後に教材・Section・賭け金・HPを決めます。'));
      for(const [op,label] of [['accept','受ける'],['decline','断る']]){
        const b=make('button',op==='accept'?'primary-button':'secondary-button',label);
        b.type='button';b.dataset.action=op;b.dataset.invitation=m.id;card.append(b);
      }$('battleIncomingList').append(card);
    }
    $('battleSentInvitations').hidden=!outgoing.length;$('battleOutgoingList').replaceChildren();
    for(const m of outgoing){
      if(!validId(m?.id))continue;
      const card=make('div','battle-invite');
      card.append(make('strong','',m.guest?.name+'へ招待中'));
      const b=make('button','text-button','取り消し');b.type='button';b.dataset.sent=m.id;card.append(b);
      $('battleOutgoingList').append(card);
    }
  }
  function offerForm(m){
    if(!m||m.status!=='setup'){$('battleOffer').hidden=true;return;}
    $('battleOffer').hidden=false;
    $('battleOfferTitle').textContent='対戦設定';
    $('battleOfferSub').textContent=m.host.name+' × '+m.guest.name;
    $('battleSendOffer').textContent='条件を変更する';
    $('battleApprovalsBlock').hidden=false;
    $('battleOfferBack').textContent='対戦を取り消す';
    if(offerVersion!==m.offerVersion){fill(m);offerVersion=m.offerVersion;}
    const mine=m.myRole==='host'?m.host:m.guest;
    $('battleApprovals').textContent=(m.host.ready?'✓':'○')+' '+m.host.name+
      ' ／ '+(m.guest.ready?'✓':'○')+' '+m.guest.name;
    $('battleReady').disabled=!!mine?.ready||busy;
    $('battleReady').textContent=mine?.ready?'承認済み・相手を待機':'この条件で承認して開始';
    potPreview();
  }
  function nowServer(){return Date.now()+clockOffset;}
  function roundCanAnswer(m){
    if(!m||m.status!=='playing'||!m.question||m.answered||busy||pendingAnswer)return false;
    if(m.roundPhase==='cooldown'||m.roundPhase==='timeout'||m.roundPhase==='inactive')return false;
    const start=Date.parse(m.startsAt),deadline=Date.parse(m.deadlineAt),now=nowServer();
    return Number.isFinite(start)&&Number.isFinite(deadline)&&now>=start&&now<deadline;
  }
  function displayQuestion(m){
    const q=m.question;
    if(questionId===q?.id)return;
    questionId=q?.id||null;pendingAnswer=null;feedback='';
    $('battleQuestionBlock').hidden=false;
    $('battlePrompt').textContent=q?.prompt||'次の共通問題を準備中…';
    $('battleQuestionMeta').textContent=q?'Section '+Math.ceil(q.number/100)+' / ROUND '+m.round:'同じ問題を2人に配信します';
    $('battleChoices').replaceChildren();
    if(q&&Array.isArray(q.choices))q.choices.forEach((option,index)=>{
      const button=make('button','battle-choice');
      button.type='button';
      button.append(make('span','battle-letter','ABCD'[index]||''),make('span','',option.text));
      button.addEventListener('click',()=>void answer(q.id,option.id));
      $('battleChoices').append(button);
    });
  }
  function renderStamp(m){
    const stamp=$('battleHitStamp'),result=m.roundResult,wrong=m.wrongHit;
    const wrongThisRound=wrong?.round===m.round;
    const isHit=m.roundPhase==='cooldown'&&result?.attacker;
    const isOwnWrong=wrongThisRound&&nowServer()-Date.parse(wrong.createdAt)<1750;
    let key=null,kind='',title='',hint='',symbol='';
    if(isHit){
      const attacking=result.attacker===m.myRole;
      const extra=attacking?0:(wrongThisRound?10:0);
      kind=attacking?'is-attack':'is-damage';
      symbol=attacking?'⚔':'💥';
      title=attacking?'攻撃成功 +'+result.damage:'被ダメージ −'+(result.damage+extra);
      hint=attacking?'相手HP −'+result.damage:
        (extra?'相手の攻撃 −'+result.damage+' / 誤答 −10':'相手の攻撃 −'+result.damage);
      key=m.id+':'+result.round+':'+kind+':'+(result.damage+extra);
    }else if(isOwnWrong){
      kind='is-damage';symbol='💥';title='誤答 −10';hint='自分のHP −10';
      key=m.id+':'+m.round+':wrong:'+wrong.createdAt;
    }else if(m.roundPhase==='cooldown'&&result&&!result.attacker){
      kind='is-neutral';title=wrongThisRound?'誤答 −10':'次の問題へ';
      symbol=wrongThisRound?'💥':'';
      hint=wrongThisRound?'自分のHP −10':'';
      key=m.id+':'+result.round+':neutral:'+String(wrongThisRound);
    }
    if(!key){stamp.hidden=true;shownStampKey=null;return;}
    if(shownStampKey!==key){
      stamp.className='battle-hit-stamp '+(kind==='is-neutral'&&wrongThisRound?'is-damage':kind);
      stamp.replaceChildren(make('span','battle-hit-symbol',symbol),
        make('strong','',title),make('small','',hint));
      shownStampKey=key;
    }
    stamp.hidden=false;
  }
  function renderGame(m){
    $('battleHostName').textContent=m.host.name;$('battleGuestName').textContent=m.guest.name;
    $('battleTotalStake').textContent=money(m.pot);
    $('battleHostAvatar').textContent=first(m.host.name);
    $('battleGuestAvatar').textContent=first(m.guest.name);
    $('battleHostHP').textContent=m.host.hp+' / '+m.initialHp+' HP';
    $('battleGuestHP').textContent=m.guest.hp+' / '+m.initialHp+' HP';
    $('battleHostFill').style.width=(Math.max(0,Math.min(1,m.host.hp/m.initialHp))*100)+'%';
    $('battleGuestFill').style.width=(Math.max(0,Math.min(1,m.guest.hp/m.initialHp))*100)+'%';
    displayQuestion(m);renderStamp(m);
    $('battleAnswerRetry').hidden=!pendingAnswer;
    $('battleFeedback').textContent=feedback;
    updateRoundClock();
  }
  function updateRoundClock(){
    if(!active||match?.status!=='playing')return;
    const m=match,meta=$('battleQuestionMeta');
    if(m.roundPhase==='cooldown'){
      const next=Math.max(0,Math.ceil((Date.parse(m.nextAt)-nowServer())/1000));
      meta.textContent='次の問題まで '+next+' 秒';
    }else if(m.roundPhase==='countdown'||m.roundPhase==='open'){
      const until=Date.parse(m.startsAt)-nowServer();
      if(until>0)meta.textContent='同時スタートまで '+Math.max(1,Math.ceil(until/1000))+' 秒';
      else if(m.answered)meta.textContent='回答済み・相手の正解を待機中';
      else meta.textContent='ROUND '+m.round+'  ·  残り'+Math.max(0,Math.ceil((Date.parse(m.deadlineAt)-nowServer())/1000))+'秒';
    }else if(m.roundPhase==='timeout')meta.textContent='この問題は時間切れ';
    for(const button of $('battleChoices').querySelectorAll('button'))button.disabled=!roundCanAnswer(m);
  }
  function renderDone(m){
    const myWin=m.winner===m.myRole;
    $('battleDoneTitle').textContent=m.status==='finished'?(myWin?'勝利！':'敗北'):'対戦終了';
    $('battleDoneMessage').textContent=m.status==='finished'?
      (myWin?'合計 '+money(2*m.stake)+' を獲得しました。':'対戦に敗北しました。'):
      '中止されました。確保済みの賭け金は返金されます。';
  }
  function render(){
    if(!active)return;
    const m=match;
    document.body.classList.toggle('battle-playing',m?.status==='playing');
    document.body.classList.toggle('battle-setup',m?.status==='setup');
    $('battleLobby').hidden=!!m&&m.status!=='invited';
    $('battleGame').hidden=m?.status!=='playing';
    $('battleDone').hidden=!m||!['finished','cancelled'].includes(m.status);
    if(!m||m.status==='invited')renderLobby();
    if(m?.status==='setup')offerForm(m);
    else $('battleOffer').hidden=true;
    if(m?.status==='playing')renderGame(m);
    if(m&&['finished','cancelled'].includes(m.status))renderDone(m);
  }
  async function refresh(){
    if(!active||fetching||busy||document.hidden)return;
    const inGame=match?.status==='playing'&&validId(matchId);
    if(!inGame&&Date.now()-lastLobbyPoll<2600)return;
    fetching=true;const lease=epoch,revision=syncRevision;
    if(!inGame)lastLobbyPoll=Date.now();
    try{
      if(inGame){
        const result=await api('state?matchId='+encodeURIComponent(matchId));
        if(!active||epoch!==lease||revision!==syncRevision)return;
        match=result.match||null;
      }else{
        const snapshot=await api('lobby');
        if(!active||epoch!==lease||revision!==syncRevision)return;
        online=Array.isArray(snapshot.online)?snapshot.online:[];
        ranking=Array.isArray(snapshot.ranking)?snapshot.ranking:[];
        incoming=Array.isArray(snapshot.incoming)?snapshot.incoming:[];
        outgoing=Array.isArray(snapshot.outgoing)?snapshot.outgoing:[];
        if(validId(snapshot.match?.id))matchId=snapshot.match.id;
        if(matchId){
          const detail=await api('state?matchId='+encodeURIComponent(matchId));
          if(!active||epoch!==lease||revision!==syncRevision)return;
          match=detail.match||null;
        }else match=null;
      }
      render();status('');
    }catch(e){if(active&&epoch===lease)status(e.message,true);}
    finally{fetching=false;}
  }
  async function mutate(action,fields){
    if(busy||!active)return;
    busy=true;syncRevision++;lastLobbyPoll=0;const lease=epoch;status('確認中…');
    try{
      const result=await api(action,{requestId:freshId(),...fields});
      if(!active||epoch!==lease)return;
      if(validId(result.match?.id))matchId=result.match.id;
      if(result.match)match=result.match;
      selected=null;render();status('');
    }catch(e){if(active&&epoch===lease)status(e.message,true);}
    finally{busy=false;if(active&&epoch===lease){render();void refresh();}}
  }
  function submitOffer(){
    if(match?.status!=='setup')return status('招待が受理されてから設定してください。',true);
    let options;try{options=params();}catch(e){status(e.message,true);return;}
    void mutate('propose',{matchId:match.id,expectedVersion:match.offerVersion,...options});
  }
  function approve(){
    if(match?.status!=='setup'||busy)return;
    let proposal;try{proposal=params();}catch(e){status(e.message,true);return;}
    const saved={book:match.book,fromSection:match.fromSection,toSection:match.toSection,stake:match.stake,initialHp:match.initialHp};
    if(Object.keys(saved).some(k=>saved[k]!==proposal[k]))
      return status('変更した設定を先に送信してから承認してください。',true);
    void mutate('ready',{matchId:match.id,expectedVersion:match.offerVersion});
  }
  function cancelOffer(){
    if(match?.status==='setup')void mutate('cancel',{matchId:match.id});
  }
  function forfeit(){
    if(match?.status==='playing'&&!busy&&window.confirm('降参すると賭け金を失い、相手に合計額が精算されます。降参しますか？'))
      void mutate('cancel',{matchId:match.id});
  }
  function answer(qid,cid){
    if(!roundCanAnswer(match)||!validId(qid)||!validId(cid)||qid!==match.question?.id)return;
    pendingAnswer={requestId:freshId(),matchId:match.id,questionId:qid,choiceId:cid};
    void submitAnswer();
  }
  async function submitAnswer(){
    if(!pendingAnswer||busy)return;
    busy=true;syncRevision++;const lease=epoch;status('判定中…');render();
    try{
      const response=await api('answer',pendingAnswer);
      if(!active||lease!==epoch)return;
      const correct=response.answer?.correct;
      feedback=correct===false?'誤答：自分のHP −10（この問題は回答済み）':
        correct===true?'正解！ 相手のHP −5':'';
      pendingAnswer=null;
      if(response.match)match=response.match;status('');
    }catch(e){
      if(active&&lease===epoch){
        if(['BATTLE_ROUND_CLOSED','BATTLE_ALREADY_ANSWERED','BATTLE_QUESTION_CHANGED','BATTLE_NOT_PLAYING'].includes(e.code)){
          pendingAnswer=null;feedback='次の問題をお待ちください。';status(''); 
        }else if(e.code==='BATTLE_ROUND_NOT_STARTED'){
          pendingAnswer=null;status('同時スタートの合図をお待ちください。');
        }else status(e.message+' 同じ回答で再確認できます。',true);
      }
    }
    finally{busy=false;if(active&&lease===epoch){render();void refresh();}}
  }
  function close(){
    active=false;epoch++;syncRevision++;
    document.body.classList.remove('battle-playing','battle-setup');
    if(timer)clearInterval(timer);timer=null;
    identity=null;matchId=null;match=null;online=[];ranking=[];incoming=[];outgoing=[];
    selected=null;offerVersion=null;questionId=null;pendingAnswer=null;feedback='';shownStampKey=null;busy=false;fetching=false;lastLobbyPoll=0;clockOffset=0;
    if($('battleApp'))$('battleApp').replaceChildren();
  }
  function open(member){
    close();if(!validId(member?.id)||typeof member?.name!=='string')return;
    identity={id:member.id,name:member.name};active=true;build();
    timer=setInterval(()=>{updateRoundClock();void refresh();},480);
    status('ログイン中のユーザーを読み込んでいます…');void refresh();
  }
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refresh();});
  $('battleRefresh')?.addEventListener('click',()=>void refresh());
  window.TargetBattleUI={open,close,refresh};
})();