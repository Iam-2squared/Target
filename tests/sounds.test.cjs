'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createCue,RATE}=require('../scripts/generate-sounds.cjs');
for(const kind of ['correct','wrong'])test(kind+' cue is reproducible, short, audible PCM without clipping',()=>{
  const buffer=fs.readFileSync(path.resolve(__dirname,'../public/audio/'+kind+'.wav'));
  assert.deepEqual(buffer,createCue(kind));assert.equal(buffer.toString('ascii',0,4),'RIFF');
  assert.equal(buffer.toString('ascii',8,12),'WAVE');assert.equal(buffer.readUInt16LE(20),1);
  assert.equal(buffer.readUInt16LE(22),1);assert.equal(buffer.readUInt32LE(24),RATE);assert.equal(buffer.readUInt16LE(34),16);
  assert.equal(buffer.readUInt32LE(40),buffer.length-44);
  const length=(buffer.length-44)/2,seconds=length/RATE;assert(seconds>=(kind==='correct'?.5:.25)&&seconds<=.65);
  let peak=0,power=0;for(let i=44;i<buffer.length;i+=2){const value=buffer.readInt16LE(i)/32768;peak=Math.max(peak,Math.abs(value));power+=value*value;}
  assert(peak>.75&&peak<.9);assert(Math.sqrt(power/length)>.08);assert.equal(buffer.readInt16LE(buffer.length-2),0);
});
test('correct and wrong cues are distinct rather than the same sound at another volume',()=>{
  assert.notDeepEqual(createCue('correct'),createCue('wrong'));assert.throws(()=>createCue('other'));
});
