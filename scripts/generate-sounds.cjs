'use strict';
// Original, deterministic PCM cues. No external recordings or build service.
const fs=require('node:fs'),path=require('node:path');
const RATE=44100;
function createCue(kind){
  if(!['correct','wrong'].includes(kind))throw new Error('Unknown cue');
  const duration=kind==='correct'?.62:.31,values=new Float64Array(Math.round(duration*RATE));
  function add(start,length,voice){
    const offset=Math.round(start*RATE),count=Math.round(length*RATE);
    for(let i=0;i<count&&offset+i<values.length;i++){
      const t=i/RATE,attack=Math.min(1,t/.003),release=Math.min(1,(length-t)/.018);
      values[offset+i]+=voice(t)*attack*release;
    }
  }
  if(kind==='correct'){
    for(let n=0;n<4;n++)add(n*.135,.15,t=>{
      // Four resonant rising "kyuin" sweeps, increasingly bright at the end.
      const length=.15,f0=620+n*55,f1=2450+n*110;
      const phase=2*Math.PI*(f0*t+(f1-f0)*t*t/(2*length));
      const shimmer=.025*Math.sin(2*Math.PI*32*t);
      return (.7*Math.sin(phase+shimmer)+.22*Math.sin(2*phase)+.08*Math.sin(3*phase))*Math.exp(-t*3.2);
    });
    add(.43,.19,t=>.18*Math.sin(2*Math.PI*2093*t)*Math.exp(-t*18));
  }else{
    for(let n=0;n<3;n++)add(n*.085,.14,t=>{
      const f0=[330,245,165][n],phase=2*Math.PI*f0*(t-.22*t*t/.14);
      return (.68*Math.sin(phase)+.22*Math.sin(3*phase)+.1*Math.sin(5*phase))*Math.exp(-t*7);
    });
    add(0,.09,t=>.2*Math.sin(2*Math.PI*65*t)*Math.exp(-t*40));
  }
  let peak=0;for(const value of values)peak=Math.max(peak,Math.abs(value));
  const pcm=Buffer.alloc(values.length*2),level=kind==='correct'?.86:.82;
  for(let i=0;i<values.length;i++){
    const fade=Math.min(1,(values.length-1-i)/(RATE*.008));
    pcm.writeInt16LE(Math.round(values[i]/peak*level*fade*32767),i*2);
  }
  const header=Buffer.alloc(44);
  header.write('RIFF',0);header.writeUInt32LE(36+pcm.length,4);header.write('WAVEfmt ',8);
  header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);
  header.writeUInt32LE(RATE,24);header.writeUInt32LE(RATE*2,28);header.writeUInt16LE(2,32);
  header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(pcm.length,40);
  return Buffer.concat([header,pcm]);
}
if(require.main===module){
  const directory=path.resolve(__dirname,'../public/audio');fs.mkdirSync(directory,{recursive:true});
  for(const kind of ['correct','wrong'])fs.writeFileSync(path.join(directory,kind+'.wav'),createCue(kind));
  console.log('Generated original short game sound cues.');
}
module.exports={createCue,RATE};
