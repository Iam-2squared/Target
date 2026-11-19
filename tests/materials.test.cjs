'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');

for(const [book,total,prefix] of [['target1900',1900,'v1900'],['target1000',1000,'i1000']]){
  test(`${book} contains every numbered source entry exactly once`,()=>{
    const entries=JSON.parse(fs.readFileSync(path.join(root,'data',book+'.json'),'utf8'));
    assert.equal(entries.length,total);
    assert.equal(new Set(entries.map(entry=>entry.id)).size,total);
    for(const [i,entry] of entries.entries()){
      assert.deepEqual(Object.keys(entry).sort(),['id','number','english','japanese'].sort());
      assert.equal(entry.number,i+1);
      assert.equal(entry.id,`${prefix}-${String(i+1).padStart(4,'0')}`);
      for(const field of ['english','japanese']){
        assert.equal(typeof entry[field],'string');
        assert.equal(entry[field],entry[field].trim());
        assert(entry[field].length>0&&entry[field].length<=1000);
        assert(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/u.test(entry[field]));
        assert(!/<\/?(?:script|iframe|html)\b/i.test(entry[field]));
      }
    }
    assert.equal(Math.ceil(entries.length/10),total/10);
    assert.equal(entries.slice(-10)[0].number,total-9);
    assert.equal(entries.slice(-10).at(-1).number,total);
  });
}
