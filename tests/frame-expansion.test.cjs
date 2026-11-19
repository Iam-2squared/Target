'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const shop=require('../server/shop.cjs');
const expanded=[
  ...Array.from({length:5},(_,i)=>'r'+String(i+11)),
  ...Array.from({length:5},(_,i)=>'e'+String(i+6).padStart(2,'0')),
  ...Array.from({length:5},(_,i)=>'l'+String(i+4).padStart(2,'0'))
];
test('the 15 new frames extend existing rarity pools with original 62/25/10/3 odds',()=>{
 assert.equal(shop.FRAMES.length,48);
 assert.equal(new Set(shop.FRAMES).size,48);
 assert.deepEqual(expanded.filter(id=>!shop.FRAMES.includes(id)),[]);
 assert.deepEqual(shop.FRAME_ODDS,{common:62,rare:25,epic:10,legendary:3});
 const counts=Object.fromEntries(Object.entries(shop.FRAME_ODDS)
   .map(([rarity])=>[rarity,shop.FRAMES.filter(id=>({c:'common',r:'rare',e:'epic',l:'legendary'})[id[0]]===rarity).length]));
 assert.deepEqual(counts,{common:15,rare:15,epic:10,legendary:8});
 assert.equal(shop.guestWallet().frameCatalogSize,48);
});
test('new frame ids parse as server-originated items, never as client-selected rewards',()=>{
 for(const id of expanded){
   const body={memberId:'11111111-1111-4111-8111-111111111111',name:'メンバー',requestId:'22222222-2222-4222-8222-222222222222',expectedCatalogVersion:5,itemType:'frame'};
   assert.equal(shop.parseInput('draw',body).itemType,'frame');
   assert.throws(()=>shop.parseInput('draw',{...body,frameId:id}));
 }
});
test('catalog migration is additive and explicitly forbids changing odds/receipt storage',()=>{
 const sql=fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261111150000_target_frames_expansion_15.sql'),'utf8');
 for(const id of expanded)assert(sql.includes("'"+id+"'"),id);
 assert(sql.includes("15*256"));
 assert(sql.includes("pg_advisory_xact_lock(991101)"));
 assert(sql.includes("wallet_snapshot"));
 assert(!/DELETE FROM target_private\.(item_draws|item_sales|profiles)/.test(sql));
});
