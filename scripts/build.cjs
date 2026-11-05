'use strict';
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..'),out=path.join(root,'dist');
for(const [book,count] of [['target1900',1900],['target1000',1000]]){
  const data=JSON.parse(fs.readFileSync(path.join(root,'data',book+'.json'),'utf8'));
  if(data.length!==count||data.some((v,i)=>v.number!==i+1||!v.id||!v.english||!v.japanese)||new Set(data.map(v=>v.id)).size!==count)throw Error('Invalid study material');
}
fs.rmSync(out,{recursive:true,force:true});
fs.cpSync(path.join(root,'public'),out,{recursive:true});
fs.mkdirSync(path.join(out,'data'),{recursive:true});
for(const book of ['target1900','target1000'])fs.copyFileSync(path.join(root,'data',book+'.json'),path.join(out,'data',book+'.json'));
console.log('Built Target study assets.');
