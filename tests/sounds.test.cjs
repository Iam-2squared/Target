'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
// Fixed digests from the selected Short MP3 members of the two user uploads.
// These tests deliberately do not regenerate or transcode those recordings.
const assets={
  correct:{bytes:21585,sha256:'9a36c84f1810ab755ff2e5814da880466c923ba04f660c971f1f228464f04aa3'},
  wrong:{bytes:12198,sha256:'62459b81bdd8763eb808d9a63251f2d9e1f50f28ead614d43568368dea3d5f51'}
};
const read=kind=>fs.readFileSync(path.resolve(__dirname,'../public/audio/'+kind+'.mp3'));
for(const [kind,expected] of Object.entries(assets))test(kind+' cue preserves the uploaded Short MP3 bytes and playable format',()=>{
  const buffer=read(kind);
  assert.equal(buffer.length,expected.bytes);
  assert.equal(crypto.createHash('sha256').update(buffer).digest('hex'),expected.sha256,'The selected user recording is unchanged');
  assert.equal(buffer.toString('ascii',0,3),'ID3','The original recording metadata is retained');
  assert(buffer.includes(Buffer.from('OtoLogic','utf16le')),'The original artist metadata is retained');
  assert([...buffer.subarray(6,10)].every(byte=>byte<128),'The ID3 size is sync-safe');
  const offset=10+((buffer[6]<<21)|(buffer[7]<<14)|(buffer[8]<<7)|buffer[9]);
  assert(offset+4<buffer.length,'An MPEG audio frame follows the metadata');
  const header=buffer.readUInt32BE(offset);
  assert.equal(header>>>21,0x7ff,'The MP3 audio sync marker is present');
  assert.equal((header>>>19)&3,3,'The asset uses MPEG-1');
  assert.equal((header>>>17)&3,1,'The asset uses Layer III');
  assert.equal((header>>>10)&3,0,'The native decoder receives 44.1 kHz audio');
  assert.notEqual((header>>>12)&15,0,'The first frame has an explicit bitrate');
  assert.notEqual((header>>>12)&15,15,'The first frame bitrate is valid');
  assert.notEqual((header>>>6)&3,3,'The original stereo audio is retained');
});
test('correct and wrong recordings remain separate uploaded assets',()=>{
  assert.notDeepEqual(read('correct'),read('wrong'));
  assert.notEqual(assets.correct.sha256,assets.wrong.sha256);
});
