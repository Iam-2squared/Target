'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const books = {
    target1900: {title:'Target 1900',kind:'英単語',total:1900},
    target1000: {title:'英熟語Target 1000',kind:'英熟語',total:1000}
  };
  const views = ['home','memorize','setup','quiz','result','ranking'];
  const MEMORY_PAGE_SIZE=5;
  const datasets = new Map(), datasetPromises = new Map();
  let selectedBook='target1900', activeView='home', member=null, lifetimeCorrect=0;
  let sessionKnown=false, sessionEpoch=0, sessionTicket=0, rankingTicket=0;
  let memoryPage=0, memoryBook='target1900', meaningsHidden=false, memoryTicket=0;
  let quiz=null, startRetry=null, starting=false, loginPending=false, logoutPending=false;
  let toastTimer;

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
  function setError(id,message='') {const node=$(id);node.textContent=message;node.hidden=!message;}
  function toast(message) {clearTimeout(toastTimer);$('toast').textContent=message;$('toast').hidden=false;toastTimer=setTimeout(()=>{$('toast').hidden=true;},3500);}
  function show(view,{scroll=true}={}) {
    activeView=view;
    document.body.dataset.view=view;
    for(const id of views)$(id+'View').hidden=id!==view;
    if(scroll)window.scrollTo({top:0,behavior:'instant'});
    document.title=view==='home'?'Target':({memorize:'暗記',setup:'テスト',quiz:'テスト',result:'テスト結果',ranking:'ランキング'}[view]+' | Target');
  }
  function home() {memoryTicket++;show('home');renderIdentity();}
  function goHome() {if(activeView==='quiz'&&quiz&&!quiz.finished){openQuit();return;}home();}
  function appError(message,code='',status=0) {const error=new Error(message);error.code=code;error.status=status;return error;}
  async function api(path,body) {
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),20000);
    try {
      const response=await fetch('/api'+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',redirect:'error',headers:body===undefined?{'Accept':'application/json'}:{'Content-Type':'application/json','Accept':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal});
      let data;try{data=await response.json();}catch{throw appError('サーバーの応答を読み込めませんでした。もう一度お試しください。');}
      if(!response.ok){const details=data?.error;throw appError(typeof details?.message==='string'?details.message:'接続に失敗しました。もう一度お試しください。',typeof details?.code==='string'?details.code:'',response.status);}
      if(!data||typeof data!=='object'||Array.isArray(data))throw appError('サーバーの応答を確認できませんでした。');
      return data;
    } catch(error) {
      if(error?.name==='AbortError')throw appError('通信に時間がかかっています。入力はそのままで、もう一度お試しください。');
      if(error instanceof TypeError)throw appError('接続できませんでした。通信状態を確認して、もう一度お試しください。');
      throw error;
    } finally {clearTimeout(timeout);}
  }
  function parseIdentity(data) {
    if(data.member!==null&&(!data.member||typeof data.member!=='object'||typeof data.member.name!=='string'||data.member.name.length>20))throw appError('アカウントの情報を確認できませんでした。');
    if(!Number.isSafeInteger(data.correctCount)||data.correctCount<0)throw appError('正解数を確認できませんでした。');
    return {member:data.member===null?null:{name:data.member.name},correctCount:data.correctCount};
  }
  function renderIdentity() {
    $('accountBadge').textContent=member?(member.name.trim()||'KGSアカウント'):(sessionKnown?'ゲスト':'接続未確認');
    $('homeScore').textContent=member?lifetimeCorrect.toLocaleString('ja-JP')+'問 正解':'';
    $('loggedInSettings').hidden=!member;$('loginForm').hidden=!!member;
    $('identityName').textContent=member?.name||'';$('identityInitial').textContent=member?.name?.trim()?.slice(0,1)||'K';
    $('settingsScore').textContent=lifetimeCorrect.toLocaleString('ja-JP')+'問';
    $('testMode').textContent=member?'ランキングに記録':'ゲスト（記録なし）';
    $('testStart').textContent=starting?'準備中…':'開始';
  }
  async function refreshSession({notify=true}={}) {
    const ticket=++sessionTicket,epoch=sessionEpoch;
    try {
      const identity=parseIdentity(await api('/session'));
      if(ticket!==sessionTicket||epoch!==sessionEpoch)return;
      member=identity.member;lifetimeCorrect=identity.correctCount;sessionKnown=true;
      $('connectionNotice').hidden=true;renderIdentity();
    } catch(error) {
      if(ticket!==sessionTicket||epoch!==sessionEpoch)return;
      if(error.status===401){member=null;lifetimeCorrect=0;sessionKnown=true;}
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
    for(const button of document.querySelectorAll('[data-book]'))button.setAttribute('aria-pressed',String(button.dataset.book===book));
    startRetry=null;
  }
  async function openMemory() {
    const book=selectedBook,ticket=++memoryTicket;
    if(memoryBook!==book)memoryPage=0;memoryBook=book;
    $('memorySheet').replaceChildren(element('p','memory-loading','読み込み中…'));
    $('memorizeBook').textContent=books[book].title;setError('memorizeError');show('memorize');
    $('memoryNext').disabled=true;$('memoryPrevious').disabled=true;
    try{await dataset(book);if(ticket===memoryTicket&&activeView==='memorize')renderMemory();}
    catch(error){if(ticket!==memoryTicket)return;setError('memorizeError',error.message);$('memorySheet').replaceChildren();$('memoryNext').disabled=false;$('memoryNext').textContent='再読み込み';}
  }
  function renderMemory() {
    const rows=datasets.get(memoryBook);if(!rows)return;
    const pageCount=Math.ceil(rows.length/MEMORY_PAGE_SIZE);memoryPage=Math.max(0,Math.min(memoryPage,pageCount-1));
    const start=memoryPage*MEMORY_PAGE_SIZE,subset=rows.slice(start,start+MEMORY_PAGE_SIZE),fragment=document.createDocumentFragment();
    for(const row of subset){const line=element('div','memory-row');line.append(element('span','word-number',row.number));const copy=element('div','memory-copy');copy.append(element('div','memory-word',row.english),element('div','memory-meaning',row.japanese));line.append(copy);fragment.append(line);}
    $('memorySheet').replaceChildren(fragment);$('memorySheet').classList.toggle('meanings-hidden',meaningsHidden);
    $('memorySheet').setAttribute('aria-label',books[memoryBook].kind+' '+(start+1)+'〜'+Math.min(start+MEMORY_PAGE_SIZE,rows.length));
    $('memorizeRange').textContent=(start+1)+'–'+Math.min(start+MEMORY_PAGE_SIZE,rows.length);
    $('memoryPrevious').disabled=memoryPage===0;$('memoryNext').disabled=false;
    $('memoryNext').textContent=memoryPage===pageCount-1?'終了':'次へ';
    $('memoryNext').setAttribute('aria-label',memoryPage===pageCount-1?'暗記を終了':'次の5個');
    if($('memoryPage').options.length!==pageCount){const options=document.createDocumentFragment();for(let index=0;index<pageCount;index++){const option=element('option','',index+1);option.value=String(index);options.append(option);}$('memoryPage').replaceChildren(options);}
    $('memoryPage').value=String(memoryPage);$('memoryPageTotal').textContent='/ '+pageCount;
    $('meaningsToggle').textContent=meaningsHidden?'訳を表示':'訳を隠す';$('meaningsToggle').setAttribute('aria-pressed',String(meaningsHidden));
  }
  function memoryNext({fromSheet=false}={}) {
    if(!datasets.has(memoryBook)){openMemory();return;}
    if(memoryPage>=Math.ceil(books[memoryBook].total/MEMORY_PAGE_SIZE)-1){if(fromSheet)toast('最後のページです');else home();return;}
    memoryPage++;renderMemory();window.scrollTo({top:0,behavior:'instant'});
  }
  function openSetup() {
    $('setupBook').textContent=books[selectedBook].title;
    $('rangeFrom').max=String(books[selectedBook].total);$('rangeTo').max=String(books[selectedBook].total);
    $('rangeFrom').value='1';$('rangeTo').value=String(books[selectedBook].total);
    setError('setupError');startRetry=null;renderIdentity();show('setup');
  }
  function questionShape(question) {
    if(!question||typeof question!=='object'||typeof question.id!=='string'||!question.id||question.id.length>150||typeof question.prompt!=='string'||!question.prompt||question.prompt.length>3000||!Number.isSafeInteger(question.number)||question.number<1||!Array.isArray(question.choices)||question.choices.length!==4||question.choices.some(c=>!c||typeof c.id!=='string'||!c.id||c.id.length>150||typeof c.text!=='string'||!c.text||c.text.length>3000)||new Set(question.choices.map(c=>c.id)).size!==4||new Set(question.choices.map(c=>normalize(c.text))).size!==4)throw appError('問題の内容を確認できませんでした。テストを終了して、もう一度お試しください。');
    return question;
  }
  function guestQuestions(rows,settings) {
    const pool=rows.filter(row=>row.number>=settings.from&&row.number<=settings.to),selected=shuffle(pool).slice(0,settings.count);
    const answerField=settings.direction==='english'?'english':'japanese',promptField=settings.direction==='english'?'japanese':'english';
    return selected.map(row=>{
      const texts=new Set([normalize(row[answerField])]),correctChoiceId=uuid();
      const choices=[{id:correctChoiceId,text:row[answerField]}];
      for(const other of shuffle(rows)){
        const normalized=normalize(other[answerField]);
        if(other.id===row.id||normalize(other.japanese)===normalize(row.japanese)||normalize(other.english)===normalize(row.english)||texts.has(normalized))continue;
        choices.push({id:uuid(),text:other[answerField]});texts.add(normalized);if(choices.length===4)break;
      }
      if(choices.length!==4)throw appError('異なる4つの選択肢を用意できませんでした。');
      return {id:uuid(),prompt:row[promptField],number:row.number,choices:shuffle(choices),correctChoiceId,correctText:row[answerField]};
    });
  }
  async function startTest(event) {
    event.preventDefault();if(starting)return;setError('setupError');
    const from=Number($('rangeFrom').value),to=Number($('rangeTo').value),count=Number($('questionCount').value),direction=document.querySelector('input[name=direction]:checked')?.value;
    if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from<1||to<from||to>books[selectedBook].total||![10,20].includes(count)||!['english','japanese'].includes(direction)){setError('setupError','出題範囲と問題数を確認してください。');return;}
    const settings={book:selectedBook,direction,count,from,to},key=JSON.stringify(settings),epoch=sessionEpoch;
    if(!startRetry||startRetry.key!==key)startRetry={key,requestId:uuid()};
    starting=true;$('testStart').disabled=true;renderIdentity();
    try {
      let created;
      if(member){
        const data=await api('/quiz/start',{...settings,requestId:startRetry.requestId});
        if(epoch!==sessionEpoch)return;
        if(typeof data.quizId!=='string'||!data.quizId||!Number.isSafeInteger(data.total)||data.total<1||data.total>count||data.answeredCount!==0||data.correctCount!==0)throw appError('テストの準備結果を確認できませんでした。');
        created={recorded:true,id:data.quizId,total:data.total,answeredCount:0,correctCount:0,question:questionShape(data.question)};
      }else{
        const questions=guestQuestions(await dataset(settings.book),settings);
        if(epoch!==sessionEpoch)return;
        created={recorded:false,id:uuid(),total:questions.length,answeredCount:0,correctCount:0,question:questions[0],questions};
      }
      quiz={...created,settings,pending:false,pendingAnswer:null,feedback:null,finished:false,sessionEpoch:epoch};startRetry=null;
      show('quiz');renderQuestion();
    } catch(error) {
      if(error.status===401){member=null;lifetimeCorrect=0;sessionKnown=true;sessionEpoch++;renderIdentity();}
      setError('setupError',error.message);
    } finally {starting=false;$('testStart').disabled=false;renderIdentity();}
  }
  function renderQuestion() {
    if(!quiz)return;const question=questionShape(quiz.question),fragment=document.createDocumentFragment();
    $('questionPosition').textContent=(quiz.answeredCount+1)+' / '+quiz.total+'問';$('quizCorrect').textContent=quiz.correctCount+'問 正解';
    $('quizProgress').max=quiz.total;$('quizProgress').value=quiz.answeredCount;
    $('quizMode').textContent=quiz.recorded?'ランキングに記録':'ゲスト';
    $('questionNumber').textContent='No. '+question.number;
    $('questionInstruction').textContent=quiz.settings.direction==='english'?'英語を選んでください':'訳を選んでください';
    $('questionPrompt').textContent=question.prompt;$('questionPrompt').closest('.question-card').classList.toggle('english-prompt',quiz.settings.direction==='japanese');
    question.choices.forEach((choice,index)=>{const button=element('button','choice-button');button.type='button';button.dataset.choiceId=choice.id;button.append(element('span','choice-letter',String.fromCharCode(65+index)),element('span','choice-text',choice.text));button.addEventListener('click',()=>answer(choice.id));fragment.append(button);});
    $('questionChoices').replaceChildren(fragment);$('answerFeedback').hidden=true;$('quizNext').hidden=true;$('answerRetry').hidden=true;setError('quizError');
    quiz.feedback=null;quiz.pendingAnswer=null;
    requestAnimationFrame(()=>{if(activeView==='quiz')$('questionPrompt').focus({preventScroll:true});});
  }
  function showAnswerResult(result) {
    if(!quiz)return;
    const question=quiz.question;
    const correctChoice=question.choices.find(choice=>choice.id===result.correctChoiceId);
    if(typeof result.correct!=='boolean'||typeof result.correctChoiceId!=='string'||!correctChoice||typeof result.correctText!=='string'||result.correctText!==correctChoice.text||result.correct!==(quiz.pendingAnswer?.choiceId===result.correctChoiceId)||!Number.isSafeInteger(result.answeredCount)||result.answeredCount!==quiz.answeredCount+1||!Number.isSafeInteger(result.correctCount)||result.correctCount!==quiz.correctCount+(result.correct?1:0)||result.total!==quiz.total||result.finished!==(result.answeredCount===quiz.total))throw appError('回答結果を確認できませんでした。同じ回答を再送してください。');
    if(!result.finished)questionShape(result.nextQuestion);
    quiz.feedback=result;quiz.answeredCount=result.answeredCount;quiz.correctCount=result.correctCount;quiz.finished=result.finished;
    for(const button of $('questionChoices').querySelectorAll('button')){button.disabled=true;button.classList.toggle('is-correct',button.dataset.choiceId===result.correctChoiceId);button.classList.toggle('is-wrong',!result.correct&&button.dataset.choiceId===quiz.pendingAnswer?.choiceId);}
    $('feedbackTitle').textContent=result.correct?'正解':'不正解';$('feedbackAnswer').textContent=result.correct?'':'正解：'+result.correctText;$('answerFeedback').classList.toggle('is-wrong',!result.correct);$('answerFeedback').hidden=false;
    $('quizCorrect').textContent=quiz.correctCount+'問 正解';$('quizProgress').value=quiz.answeredCount;
    $('quizNext').replaceChildren(document.createTextNode(result.finished?'結果を見る':'次の問題'));$('quizNext').hidden=false;$('answerRetry').hidden=true;
    setError('quizError');
  }
  async function answer(choiceId,{retry=false}={}) {
    const current=quiz;if(!current||current.pending||current.feedback)return;
    if(current.pendingAnswer&&!retry)return;
    if(!current.question.choices.some(choice=>choice.id===choiceId))return;
    if(!current.pendingAnswer)current.pendingAnswer={quizId:current.id,questionId:current.question.id,choiceId,requestId:uuid()};
    current.pending=true;$('answerRetry').disabled=true;setError('quizError');
    for(const button of $('questionChoices').querySelectorAll('button')){button.disabled=true;button.classList.toggle('selected',button.dataset.choiceId===choiceId);}
    try {
      let result;
      if(current.recorded){result=await api('/quiz/answer',current.pendingAnswer);}
      else{
        const correct=choiceId===current.question.correctChoiceId,answered=current.answeredCount+1;
        result={correct,correctChoiceId:current.question.correctChoiceId,correctText:current.question.correctText,answeredCount:answered,correctCount:current.correctCount+(correct?1:0),total:current.total,finished:answered===current.total,nextQuestion:current.questions[answered]||null};
      }
      if(quiz!==current)return;showAnswerResult(result);
    } catch(error) {
      if(quiz!==current)return;
      if(error.status===401){member=null;lifetimeCorrect=0;sessionKnown=true;sessionEpoch++;renderIdentity();}
      setError('quizError',error.message+' 回答は保持しています。');$('answerRetry').hidden=false;
    } finally {current.pending=false;$('answerRetry').disabled=false;}
  }
  function nextQuestion() {
    if(!quiz?.feedback)return;
    if(quiz.finished){showResult();return;}
    quiz.question=quiz.feedback.nextQuestion;renderQuestion();window.scrollTo({top:0,behavior:'instant'});
  }
  function showResult() {
    if(!quiz)return;
    $('resultBook').textContent=books[quiz.settings.book].title;$('resultCorrect').textContent=String(quiz.correctCount);$('resultTotal').textContent='/ '+quiz.total+'問';
    $('resultMode').textContent=quiz.recorded?'ランキングに記録':'ゲスト（記録なし）';show('result');
    if(quiz.recorded)void refreshSession({notify:false});
  }
  function openQuit() {
    if(!quiz||quiz.finished){home();return;}
    $('quitDescription').textContent=quiz.recorded?'回答済みの正解数は記録されています。':'ゲスト練習の途中経過は保存されません。';$('quitDialog').showModal();
  }
  async function openRanking() {show('ranking');await loadRanking();}
  async function loadRanking() {
    const ticket=++rankingTicket;setError('rankingError');$('rankingStatus').textContent='読み込み中…';$('rankingRefresh').disabled=true;$('rankingList').replaceChildren();
    try {
      const data=await api('/ranking');if(ticket!==rankingTicket)return;
      if(!Array.isArray(data.ranking)||data.ranking.length>1000||data.ranking.some(row=>!row||!Number.isSafeInteger(row.rank)||row.rank<1||typeof row.name!=='string'||row.name.length>20||!Number.isSafeInteger(row.correctCount)||row.correctCount<0))throw appError('ランキングの内容を確認できませんでした。');
      const fragment=document.createDocumentFragment();
      for(const row of data.ranking){const item=element('li','ranking-row'),score=element('span','ranking-score',row.correctCount.toLocaleString('ja-JP'));score.append(element('small','', '問'));item.append(element('span','ranking-place',row.rank),element('span','ranking-name',row.name.trim()||'名前未設定'),score);fragment.append(item);}
      $('rankingList').replaceChildren(fragment);$('rankingStatus').textContent=data.ranking.length?'':'まだテストの記録はありません。';
    } catch(error) {if(ticket===rankingTicket){$('rankingStatus').textContent='';setError('rankingError',error.message);}}
    finally {if(ticket===rankingTicket)$('rankingRefresh').disabled=false;}
  }
  function setPinVisible(visible) {$('accountPin').type=visible?'text':'password';$('pinVisibility').textContent=visible?'隠す':'表示';$('pinVisibility').setAttribute('aria-pressed',String(visible));$('pinVisibility').setAttribute('aria-label',visible?'PINを隠す':'PINを表示');}
  function openSettings() {setError('settingsError');$('settingsStatus').textContent='';renderIdentity();$('settingsDialog').showModal();}
  async function login(event) {
    event.preventDefault();if(loginPending||logoutPending)return;setError('settingsError');$('settingsStatus').textContent='';
    const attendanceNumber=Number($('attendanceNumber').value),accountPin=$('accountPin').value;
    if(!/^[0-9]{1,2}$/.test($('attendanceNumber').value)||!((attendanceNumber>=1&&attendanceNumber<=40)||attendanceNumber===99)||!/^[0-9]{4}$/.test(accountPin)){setError('settingsError','出席番号と4桁のPINを確認してください。');return;}
    loginPending=true;for(const id of ['attendanceNumber','accountPin','pinVisibility','loginButton'])$(id).disabled=true;$('loginButton').textContent='ログイン中…';
    try {
      const identity=parseIdentity(await api('/login',{attendanceNumber,accountPin}));if(!identity.member)throw appError('ログイン情報を確認できませんでした。');
      sessionEpoch++;sessionTicket++;member=identity.member;lifetimeCorrect=identity.correctCount;sessionKnown=true;$('accountPin').value='';$('attendanceNumber').value='';setPinVisible(false);$('connectionNotice').hidden=true;renderIdentity();$('settingsStatus').textContent='ログインしました。';
    } catch(error){setError('settingsError',error.message);}
    finally{loginPending=false;for(const id of ['attendanceNumber','accountPin','pinVisibility','loginButton'])$(id).disabled=false;$('loginButton').textContent='ログイン';if(!$('settingsDialog').open){$('accountPin').value='';setPinVisible(false);}}
  }
  async function logout() {
    if(loginPending||logoutPending)return;logoutPending=true;$('logoutButton').disabled=true;setError('settingsError');$('settingsStatus').textContent='';
    try {
      await api('/logout',{});sessionEpoch++;sessionTicket++;member=null;lifetimeCorrect=0;sessionKnown=true;$('accountPin').value='';$('attendanceNumber').value='';setPinVisible(false);renderIdentity();$('settingsStatus').textContent='ログアウトしました。';
      if(activeView==='quiz'&&quiz?.recorded){quiz=null;home();}
    } catch(error){setError('settingsError',error.message);}
    finally{logoutPending=false;$('logoutButton').disabled=false;}
  }

  for(const button of document.querySelectorAll('[data-book]'))button.addEventListener('click',()=>selectBook(button.dataset.book));
  for(const button of document.querySelectorAll('[data-home]'))button.addEventListener('click',goHome);
  $('brandHome').addEventListener('click',goHome);$('memorizeOpen').addEventListener('click',openMemory);$('testOpen').addEventListener('click',openSetup);
  $('memoryNext').addEventListener('click',()=>memoryNext());$('memoryPrevious').addEventListener('click',()=>{if(memoryPage>0){memoryPage--;renderMemory();window.scrollTo({top:0,behavior:'instant'});}});
  $('memoryPage').addEventListener('change',()=>{memoryPage=Number($('memoryPage').value);renderMemory();window.scrollTo({top:0,behavior:'instant'});});
  $('meaningsToggle').addEventListener('click',()=>{meaningsHidden=!meaningsHidden;renderMemory();});
  $('memorySheet').addEventListener('click',()=>{if(window.getSelection()?.toString())return;memoryNext({fromSheet:true});});
  $('testForm').addEventListener('submit',startTest);$('quizNext').addEventListener('click',nextQuestion);$('answerRetry').addEventListener('click',()=>{if(quiz?.pendingAnswer)void answer(quiz.pendingAnswer.choiceId,{retry:true});});
  $('quizQuit').addEventListener('click',openQuit);$('quitCancel').addEventListener('click',()=>$('quitDialog').close());$('quitConfirm').addEventListener('click',()=>{$('quitDialog').close();quiz=null;home();});
  $('testAgain').addEventListener('click',()=>{if(quiz)selectedBook=quiz.settings.book;selectBook(selectedBook);openSetup();});
  $('rankingOpen').addEventListener('click',openRanking);$('resultRanking').addEventListener('click',openRanking);$('rankingRefresh').addEventListener('click',loadRanking);
  $('settingsOpen').addEventListener('click',openSettings);$('settingsClose').addEventListener('click',()=>$('settingsDialog').close());$('loginForm').addEventListener('submit',login);$('logoutButton').addEventListener('click',logout);$('pinVisibility').addEventListener('click',()=>setPinVisible($('accountPin').type==='password'));
  $('sourcesOpen').addEventListener('click',event=>{event.preventDefault();$('sourcesDialog').showModal();});$('sourcesClose').addEventListener('click',()=>$('sourcesDialog').close());
  $('settingsDialog').addEventListener('close',()=>{if(!loginPending){$('accountPin').value='';setPinVisible(false);}});
  document.addEventListener('keydown',event=>{if(activeView!=='memorize'||document.querySelector('dialog[open]')||['INPUT','SELECT','TEXTAREA','BUTTON'].includes(document.activeElement?.tagName))return;if(event.key==='ArrowRight'){event.preventDefault();memoryNext({fromSheet:true});}if(event.key==='ArrowLeft'&&memoryPage>0){event.preventDefault();memoryPage--;renderMemory();window.scrollTo({top:0,behavior:'instant'});}});
  renderIdentity();void refreshSession();
})();
