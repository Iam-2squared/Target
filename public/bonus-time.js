(function(root,factory){
  'use strict';
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.TargetBonusTime=factory();
})(typeof globalThis==='object'?globalThis:this,function(){
  'use strict';
  const DURATION=15900,AUDIO='/audio/bonus-100000.mp3';
  const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  function record(value){
    if(value===null||value===undefined)return null;
    if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.id!=='string'||!UUID.test(value.id)||
      typeof value.startedAt!=='string'||value.startedAt.length>64||typeof value.endsAt!=='string'||value.endsAt.length>64||value.durationMs!==DURATION)throw new Error('ボーナス時間を確認できませんでした。');
    const start=Date.parse(value.startedAt),end=Date.parse(value.endsAt);
    if(!Number.isFinite(start)||!Number.isFinite(end)||Math.abs(end-start-DURATION)>1)throw new Error('ボーナス時間を確認できませんでした。');
    return {id:value.id.toLowerCase(),startedAt:new Date(start).toISOString(),endsAt:new Date(end).toISOString(),durationMs:DURATION};
  }
  function uuid(){
    if(typeof crypto.randomUUID==='function')return crypto.randomUUID();
    const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
    const hex=Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');return hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20);
  }
  class Bonus{
    constructor({session=()=>0,soundEnabled=()=>true,claimAudioSession=()=>null,releaseAudioSession=()=>{},onPlaybackStart=()=>{},onForeground=()=>{}}={}){
      this.session=session;this.soundEnabled=soundEnabled;this.claimAudioSession=claimAudioSession;this.releaseAudioSession=releaseAudioSession;this.onPlaybackStart=onPlaybackStart;this.onForeground=onForeground;
      this.epoch=session();this.value=null;this.deadline=0;this.wallDeadline=0;this.latestStart=-Infinity;this.latestId=null;this.closedId=null;this.completedId=null;this.timer=null;this.audio=null;this.attempt=null;this.tail=null;this.generation=0;this.enabled=null;
      this.makeUI();
      this.visibility=()=>{if(document.hidden)this.stopAudio();else{this.render();try{this.onForeground();}catch{}}};
      this.hidePage=()=>this.reset();
      document.addEventListener('visibilitychange',this.visibility);window.addEventListener('pagehide',this.hidePage);
    }
    makeUI(){
      const banner=document.createElement('aside');banner.id='bonusTimeBanner';banner.className='target-bonus-banner';banner.hidden=true;banner.setAttribute('aria-label','ボーナスタイム');
      const copy=document.createElement('div');copy.className='target-bonus-copy';
      const title=document.createElement('strong');title.textContent='ボーナスタイム';title.setAttribute('role','status');
      const detail=document.createElement('span');detail.textContent='正解500轟';copy.append(title,detail);
      const remaining=document.createElement('span');remaining.id='bonusTimeRemaining';remaining.className='target-bonus-remaining';remaining.setAttribute('role','timer');remaining.setAttribute('aria-live','off');
      const resume=document.createElement('button');resume.id='bonusAudioResume';resume.type='button';resume.textContent='音を再生';resume.hidden=true;resume.onclick=()=>this.gesture();
      banner.append(copy,remaining,resume);
      const shell=document.querySelector('.app-shell')||document.body,main=shell.querySelector('main');shell.insertBefore(banner,main||null);
      this.banner=banner;this.remainingNode=remaining;this.resume=resume;
    }
    enabledNow(){return this.enabled===null?!!this.soundEnabled():this.enabled;}
    ensure(){if(this.epoch!==this.session())this.reset();}
    remaining(){return this.value?Math.max(0,Math.min(this.deadline-performance.now(),this.wallDeadline-Date.now())):0;}
    active(){this.ensure();if(this.value&&!this.remaining())this.expire();return !!this.value;}
    snapshot(){return this.active()?{...this.value}:null;}
    elapsed(){return Math.max(0,Math.min(DURATION/1000,(DURATION-this.remaining())/1000));}
    update(input,timing={}){
      this.ensure();const next=record(input),now=performance.now();
      if(!next){
        if(this.value&&Number.isFinite(timing.serverNowMs)&&timing.serverNowMs>=Date.parse(this.value.endsAt))this.expire();
        this.render();return this.snapshot();
      }
      const start=Date.parse(next.startedAt),end=Date.parse(next.endsAt);
      if(start<this.latestStart||start===this.latestStart&&this.latestId&&next.id!==this.latestId||next.id===this.closedId)return this.snapshot();
      const same=next.id===this.value?.id;
      if(same&&(next.startedAt!==this.value.startedAt||next.endsAt!==this.value.endsAt))throw new Error('ボーナス時間を確認できませんでした。');
      const received=Number.isFinite(timing.receivedAtMs)?Math.min(now,timing.receivedAtMs):now;
      const sent=Number.isFinite(timing.requestStartedAtMs)?Math.min(received,timing.requestStartedAtMs):received;
      const serverNow=Number.isFinite(timing.serverNowMs)?timing.serverNowMs:Date.now();
      const roundTrip=Math.max(0,received-sent),processing=timing.serverProcessingMs;
      // The fresh server clock is already sampled after authentication and DB
      // work. Only estimate network transit, never subtract that work twice.
      const halfNetwork=Number.isFinite(processing)&&processing>=0&&processing<=roundTrip?Math.max(0,roundTrip-processing)/2:0;
      // Convert the server's fixed expiry to a monotonic local deadline. Neither
      // receiving the same receipt again nor moving the client clock extends it.
      const remaining=Math.min(DURATION,end-serverNow-Math.max(0,now-received)-Math.min(DURATION,halfNetwork));
      this.latestStart=Math.max(start,this.latestStart);this.latestId=next.id;
      if(remaining<=0){if(!this.value||start>=Date.parse(this.value.startedAt))this.expire(next.id);return this.snapshot();}
      if(!same){this.stopAudio();this.value=next;this.deadline=now+remaining;this.wallDeadline=Date.now()+remaining;}
      else{this.deadline=Math.min(this.deadline,now+remaining);this.wallDeadline=Math.min(this.wallDeadline,Date.now()+remaining);}
      this.render();if(!same&&this.completedId!==next.id)this.play();return this.snapshot();
    }
    startGuest(){
      this.ensure();if(this.active())return this.snapshot();
      const start=Math.max(Date.now(),Number.isFinite(this.latestStart)?this.latestStart+1:0);
      const next={id:uuid(),startedAt:new Date(start).toISOString(),endsAt:new Date(start+DURATION).toISOString(),durationMs:DURATION};
      this.update(next,{serverNowMs:start,requestStartedAtMs:performance.now(),receivedAtMs:performance.now()});return this.snapshot();
    }
    prepare(){
      if(!this.enabledNow()||this.audio||typeof window.Audio!=='function')return this.audio;
      try{const player=new Audio(AUDIO);player.id='bonusTimeAudio';player.preload='auto';player.loop=false;player.volume=.85;player.hidden=true;player.setAttribute('playsinline','');player.setAttribute('aria-hidden','true');player.tabIndex=-1;document.body.append(player);player.load();this.audio=player;}catch{}
      return this.audio;
    }
    seek(player,{force=false}={}){try{const time=this.elapsed(),target=Number.isFinite(player.duration)&&player.duration>0?Math.min(time,Math.max(0,player.duration-.01)):time;if(force||Math.abs(player.currentTime-target)>.08)player.currentTime=target;}catch{}}
    cancelTail(tail=this.tail){
      if(!tail||this.tail!==tail)return;
      this.tail=null;clearTimeout(tail.timer);
      for(const [name,fn]of tail.listeners)tail.player.removeEventListener(name,fn);
      try{tail.player.pause();}catch{}
      try{this.releaseAudioSession(tail.lease);}catch{}
    }
    finishAudioTail(id){
      const attempt=this.attempt,player=attempt?.player;
      const left=player&&Number.isFinite(player.duration)?player.duration-player.currentTime:Infinity;
      if(!attempt||!attempt.playing||attempt.id!==id||attempt.epoch!==this.session()||!this.enabledNow()||document.hidden||player.paused||player.ended||player.readyState<2||left<=0||left>.35)return false;
      this.cancelTail();this.generation++;this.attempt=null;
      for(const [name,fn]of attempt.listeners)player.removeEventListener(name,fn);
      // Reward time and the gold UI still end now. Only an already-playing
      // final fraction of the clip may finish naturally; it cannot be replayed.
      const tail={player,lease:attempt.lease,id,listeners:[],timer:null};this.tail=tail;this.completedId=id;
      const finish=()=>this.cancelTail(tail);
      tail.listeners=[['ended',finish],['pause',finish],['error',finish]];
      for(const [name,fn]of tail.listeners)player.addEventListener(name,fn);
      tail.timer=setTimeout(finish,Math.min(350,Math.max(1,left*1000+50)));
      return true;
    }
    stopAudio(){
      this.cancelTail();
      this.generation++;const attempt=this.attempt;this.attempt=null;
      if(attempt){for(const [name,fn]of attempt.listeners)attempt.player.removeEventListener(name,fn);try{this.releaseAudioSession(attempt.lease);}catch{}}
      if(this.audio)try{this.audio.pause();}catch{}
      if(this.resume)this.resume.hidden=!this.value||!this.enabledNow()||document.hidden||this.completedId===this.value.id;
    }
    play(){
      if(!this.active()||!this.enabledNow()||document.hidden||this.completedId===this.value.id||this.attempt)return false;
      const player=this.prepare();if(!player){this.render();return false;}
      const epoch=this.epoch,id=this.value.id,generation=++this.generation,attempt={player,epoch,id,generation,lease:null,listeners:[],playing:false};
      this.attempt=attempt;
      const current=()=>this.attempt===attempt&&epoch===this.session()&&this.value?.id===id&&this.remaining()>0;
      const finish=event=>{
        if(!current())return;
        if(event?.type==='ended'&&!player.ended)return;
        if(event?.type==='pause'&&!player.paused)return;
        if(event?.type==='ended')this.completedId=id;
        this.stopAudio();this.render();
      };
      const playing=()=>{if(!current()){if(!this.attempt&&!this.tail)try{player.pause();}catch{}return;}attempt.playing=true;this.seek(player);this.render();};
      const metadata=()=>{if(current())this.seek(player,{force:true});};
      attempt.listeners=[['playing',playing],['loadedmetadata',metadata],['ended',finish],['pause',finish],['error',finish]];
      for(const [name,fn]of attempt.listeners)player.addEventListener(name,fn);
      try{
        attempt.lease=this.claimAudioSession();this.onPlaybackStart();
        if(player.error)player.load();player.muted=false;player.volume=.85;this.seek(player,{force:true});
        // Keep the native play() directly in gesture() when the platform needs
        // a user gesture. Rejected autoplay offers that explicit retry button.
        const promise=player.play();
        void Promise.resolve(promise).then(()=>{
          if(!current()){if(!this.attempt&&!this.tail)try{player.pause();}catch{}return;}
          if(!this.enabledNow()||document.hidden)this.stopAudio();this.render();
        },()=>{if(current()){this.stopAudio();this.render();}});
      }catch{if(current()){this.stopAudio();this.render();}}
      this.render();return true;
    }
    gesture(){this.ensure();return this.play();}
    setSoundEnabled(enabled){this.enabled=!!enabled;if(!enabled)this.stopAudio();else this.play();this.render();}
    render(){
      if(this.epoch!==this.session()){this.reset();return;}
      clearTimeout(this.timer);this.timer=null;
      if(this.value&&!this.remaining()){this.expire();return;}
      const active=!!this.value;document.documentElement.classList.toggle('target-bonus-active',active);this.banner.hidden=!active;
      if(!active){this.remainingNode.textContent='';this.resume.hidden=true;return;}
      const seconds=Math.ceil(this.remaining()/1000);this.remainingNode.textContent=seconds+'秒';this.remainingNode.setAttribute('aria-label','残り'+seconds+'秒');
      this.resume.hidden=!this.enabledNow()||document.hidden||!!this.attempt||this.completedId===this.value.id;
      this.timer=setTimeout(()=>this.render(),Math.min(200,Math.max(1,this.remaining())));
    }
    expire(id=this.value?.id){if(id!==this.value?.id||!this.finishAudioTail(id))this.stopAudio();this.closedId=id||this.closedId;this.value=null;this.deadline=0;this.wallDeadline=0;clearTimeout(this.timer);this.timer=null;this.render();}
    reset(){this.stopAudio();this.epoch=this.session();this.value=null;this.deadline=0;this.wallDeadline=0;this.latestStart=-Infinity;this.latestId=null;this.closedId=null;this.completedId=null;if(this.audio)try{this.audio.currentTime=0;}catch{}clearTimeout(this.timer);this.timer=null;this.render();}
    destroy(){this.reset();document.removeEventListener('visibilitychange',this.visibility);window.removeEventListener('pagehide',this.hidePage);this.banner.remove();this.audio?.remove();this.audio=null;}
  }
  return Object.freeze({DURATION,AUDIO,record,create:options=>new Bonus(options)});
});
