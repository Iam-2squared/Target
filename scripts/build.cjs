'use strict';
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..'),out=path.join(root,'dist');
const {books,sectionForWord}=require('../public/materials.js');
for(const [book,material] of Object.entries(books)){
  const count=material.total;
  const data=JSON.parse(fs.readFileSync(path.join(root,'data',book+'.json'),'utf8'));
  if(data.length!==count||data.some((v,i)=>v.number!==i+1||v.id!==material.prefix+'-'+String(i+1).padStart(4,'0')||!v.english||!v.japanese||!sectionForWord(book,v.number)||(v.section!==undefined&&v.section!==sectionForWord(book,v.number).section))||new Set(data.map(v=>v.id)).size!==count)throw Error('Invalid study material: '+book);
}
fs.rmSync(out,{recursive:true,force:true});
fs.cpSync(path.join(root,'public'),out,{recursive:true});
fs.mkdirSync(path.join(out,'data'),{recursive:true});
for(const book of Object.keys(books))fs.copyFileSync(path.join(root,'data',book+'.json'),path.join(out,'data',book+'.json'));
console.log('Built Target study assets.');
