'use strict';
// Independent financial verification, disposable loopback PostgreSQL only.
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs/promises'),path=require('node:path');
const {Client,Pool}=require('pg'),shop=require('../server/shop.cjs'),{generateQuestions}=require('../server/questions.cjs');
assert.equal(process.env.NODE_ENV,'test');const source=new URL(process.env.DATABASE_URL||'');assert(['localhost','127.0.0.1','[::1]'].includes(source.hostname));
const name='target_zero_wallet_independent_test',url=new URL(source),adminURL=new URL(source);url.pathname='/'+name;adminURL.pathname='/postgres';
const root=path.resolve(__dirname,'..'),dir=path.join(root,'supabase/migrations'),migration='20261109112326_target_zero_wallet_receipt_writeoffs.sql';
const db=new Pool({connectionString:url.href,max:10}),secret=crypto.randomBytes(32).toString('hex'),uuid=()=>crypto.randomUUID();
let checks=0;const phases=[];const eq=(a,b,m)=>{checks++;assert.deepEqual(a,b,m);},ok=(v,m)=>{checks++;assert(v,m);};
const a={memberId:uuid(),name:'ゼロ残高A'},b={memberId:uuid(),name:'変更しないB'};
const manifest=(member,totalIncome)=>({version:1,reason:'明示された総所得と保有額ゼロへの調整',targets:[{memberId:member.memberId,expectedName:member.name,totalIncome}]});
const operation='zero_income_independent_exact',request=manifest(a,4000000);
const rpc=(fn,action,input)=>(db.query('SELECT public.'+fn+'($1,$2,$3::jsonb) v',[secret,action,JSON.stringify(input)])).then(r=>r.rows[0].v);
const apply=(id,body,client=db)=>client.query('SELECT target_private.zero_wallet_income($1,$2::jsonb) v',[id,JSON.stringify(body)]).then(r=>r.rows[0].v);
const wallet=member=>db.query('SELECT target_private.wallet_snapshot($1) v',[member.memberId]).then(r=>r.rows[0].v);
const profile=member=>db.query('SELECT to_jsonb(p) v FROM target_private.profiles p WHERE member_id=$1',[member.memberId]).then(r=>r.rows[0].v);
const histories=()=>db.query("SELECT jsonb_build_object('answers',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY quiz_id,question_id),'[]') FROM target_private.answers a),'credits',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY user_id,source_points),'[]') FROM target_private.calculus_credits c),'links',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY user_id),'[]') FROM target_private.calculus_links c),'draws',(SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY member_id,request_id),'[]') FROM target_private.item_draws d),'legacy',(SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY member_id,request_id),'[]') FROM target_private.sticker_draws d),'voids',(SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY member_id,request_id),'[]') FROM target_private.inventory_voids v),'map',(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY member_id,request_id),'[]') FROM target_private.map_purchases m)) v").then(r=>r.rows[0].v);
const projection=async()=>eq((await db.query('SELECT count(*)::integer n FROM target_private.wallet_finance_projection(NULL) l JOIN target_private.profiles p USING(member_id) WHERE (p.total_points,p.spent_points,p.calculus_points,p.birthday_points,p.casino_net,p.calculus_forgiven_points) IS DISTINCT FROM (l.total_points,l.spent_points,l.calculus_points,l.birthday_points,l.casino_net,l.calculus_forgiven_points)')).rows[0].n,0,'Every wallet reconciles with the permanent financial ledger');
async function phase(label,fn){await fn();phases.push(label);console.log('PASS '+label);}
async function earn(member){const questions=generateQuestions({book:'target1900',direction:'english',from:1,to:1,count:10,requestId:uuid()});const start=await rpc('target_rpc','start',{...member,book:'target1900',direction:'english',from:1,to:1,requestId:uuid(),questions});ok(!start.error);const answer=await rpc('target_rpc','answer',{...member,quizId:start.quizId,questionId:questions[0].id,choiceId:questions[0].correctChoiceId,requestId:uuid()});ok(!answer.error);return answer;}
async function rejectedMutation(fn,code){await assert.rejects(fn(),e=>!code||e.code===code);checks++;}
async function seedDraws(member,count){const ids=Array.from({length:count},uuid),client=await db.connect();try{await client.query('BEGIN');await client.query("SELECT set_config('target.gacha_catalog_protocol','3',true),set_config('target.gacha_price_protocol','100000',true),set_config('target.gacha_inventory_protocol','active-v1',true)");await client.query("INSERT INTO target_private.item_draws(member_id,request_id,item_type,sticker_id,cost) SELECT $1,id,'sticker','youth',100000 FROM unnest($2::uuid[]) id",[member.memberId,ids]);await client.query('UPDATE target_private.profiles SET spent_points=spent_points+$2 WHERE member_id=$1',[member.memberId,count*100000]);await client.query('COMMIT');return ids;}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}
async function criticalOverlapCases(){
 const dbName='target_zero_wallet_overlap_independent_test',targetURL=new URL(source);targetURL.pathname='/'+dbName;
 const admin=new Client({connectionString:adminURL.href});await admin.connect();try{await admin.query('DROP DATABASE IF EXISTS '+dbName+' WITH(FORCE)');await admin.query('CREATE DATABASE '+dbName);}finally{await admin.end();}
 const isolated=new Pool({connectionString:targetURL.href,max:4}),c={memberId:uuid(),name:'全体返金C'},d={memberId:uuid(),name:'境界返金D'};
 const call=(fn,action,input)=>isolated.query('SELECT public.'+fn+'($1,$2,$3::jsonb) v',[secret,action,JSON.stringify(input)]).then(r=>r.rows[0].v);
 const zero=(id,member,totalIncome)=>isolated.query('SELECT target_private.zero_wallet_income($1,$2::jsonb) v',[id,JSON.stringify(manifest(member,totalIncome))]).then(r=>r.rows[0].v);
 const getWallet=member=>isolated.query('SELECT target_private.wallet_snapshot($1) v',[member.memberId]).then(r=>r.rows[0].v);
 const purchase=async member=>{const result=await call('target_shop_rpc','draw',{...member,requestId:uuid(),itemType:'sticker',expectedPrice:100000,expectedCatalogVersion:3});ok(!result.error);return result;};
 const snapshot=client=>client.query('SELECT target_private.wallet_finance_snapshot() v').then(r=>r.rows[0].v);
 const reconcile=async()=>eq((await isolated.query('SELECT count(*)::integer n FROM target_private.wallet_finance_projection(NULL) l JOIN target_private.profiles p USING(member_id) WHERE (p.total_points,p.spent_points,p.calculus_points,p.birthday_points,p.casino_net,p.calculus_forgiven_points) IS DISTINCT FROM (l.total_points,l.spent_points,l.calculus_points,l.birthday_points,l.casino_net,l.calculus_forgiven_points)')).rows[0].n,0);
 try{
  for(const file of(await fs.readdir(dir)).filter(f=>/^\d+_.*\.sql$/.test(f)&&f<=migration).sort())await isolated.query(await fs.readFile(path.join(dir,file),'utf8'));
  await isolated.query("INSERT INTO target_private.server_credentials(singleton,key_hash) VALUES(true,encode(sha256(convert_to($1,'UTF8')),'hex'))",[secret]);
  await phase('a common earlier financial cutoff supersedes partial writeoffs and inventory never double-refunds',async()=>{
   ok((await call('target_calculus_rpc','link',{...c,userId:31,totalPoints:100,known:true,deleted:false})).linked);
   const at=(await isolated.query('SELECT clock_timestamp()::text at')).rows[0].at;
   await purchase(c);await purchase(c);ok(!(await zero('zero_income_overlap_common',c,60000)).replayed);const adjusted=await getWallet(c);eq(adjusted.refundedSpend,140000);eq(adjusted.spent,60000);
   const before=await snapshot(isolated);const restored=(await isolated.query("SELECT target_private.restore_wallet_finances('zero-common-finance',$1,$2::jsonb,$3) v",[at,JSON.stringify(before),'e'.repeat(64)])).rows[0].v;eq(restored.replayed,false);
   const financeWallet=await getWallet(c);eq(financeWallet.spent,0);eq(financeWallet.totalIncome,1000000);eq(financeWallet.refundedSpend,200000);shop.validateWallet(financeWallet);checks++;
   const proof=(await isolated.query('SELECT target_private.receipt_financial_refund_amount(member_id,request_id)::integer n FROM target_private.item_draws WHERE member_id=$1 ORDER BY request_id',[c.memberId])).rows.map(r=>r.n);eq(proof,[100000,100000]);
   const inventory=(await isolated.query("SELECT target_private.restore_inventory('zero-common-inventory',$1,'zero-common-finance') v",[at])).rows[0].v;eq(inventory.voidedDraws,2);eq(inventory.additionalRefund,0);eq((await getWallet(c)).balance,1000000);eq((await getWallet(c)).voidedDrawCount,2);shop.validateWallet(await getWallet(c));checks++;await reconcile();
   const after=await getWallet(c);eq((await zero('zero_income_overlap_common',c,60000)).replayed,true);eq(await getWallet(c),after);
  });
  await phase('an ambiguous cross-cutoff positive refund fails at commit and rolls back every wallet and audit row',async()=>{
   ok((await call('target_calculus_rpc','link',{...d,userId:32,totalPoints:100,known:true,deleted:false})).linked);
   const first=await purchase(d),at=(await isolated.query('SELECT clock_timestamp()::text at')).rows[0].at;
   const second=await purchase(d);ok(!(await zero('zero_income_overlap_ambiguous',d,60000)).replayed);
   const allocation=(await isolated.query('SELECT request_id,amount::integer FROM target_private.manual_receipt_writeoffs WHERE reset_id=$1 ORDER BY amount',['zero_income_overlap_ambiguous'])).rows;eq(allocation,[{request_id:first.requestId,amount:40000},{request_id:second.requestId,amount:100000}]);
   await isolated.query("SELECT target_private.adjust_wallet_income('income_adjust_overlap_refill',$1::jsonb)",[JSON.stringify(manifest(d,1000000))]);await purchase(d);eq((await getWallet(d)).spent,160000);
   const allBefore=(await isolated.query('SELECT jsonb_agg(to_jsonb(p) ORDER BY member_id) v FROM target_private.profiles p')).rows[0].v;
   const auditBefore=(await isolated.query('SELECT count(*)::integer n FROM target_private.wallet_restoration_events')).rows[0].n,tx=await isolated.connect();
   try{await tx.query('BEGIN');const before=await snapshot(tx);const returned=(await tx.query("SELECT target_private.restore_wallet_finances('zero-ambiguous-finance',$1,$2::jsonb,$3) v",[at,JSON.stringify(before),'f'.repeat(64)])).rows[0].v;eq(returned.replayed,false,'The positive60000 financial refund reaches deferred coverage checking');
    const pending=(await tx.query("SELECT spent_refund::integer n FROM target_private.wallet_restorations WHERE reset_id='zero-ambiguous-finance' AND member_id=$1",[d.memberId])).rows[0].n;eq(pending,60000);
    await rejectedMutation(()=>tx.query('COMMIT'),'23514');await tx.query('ROLLBACK');
   }finally{await tx.query('ROLLBACK').catch(()=>{});tx.release();}
   eq((await isolated.query('SELECT jsonb_agg(to_jsonb(p) ORDER BY member_id) v FROM target_private.profiles p')).rows[0].v,allBefore);eq((await isolated.query('SELECT count(*)::integer n FROM target_private.wallet_restoration_events')).rows[0].n,auditBefore);eq((await isolated.query("SELECT count(*)::integer n FROM target_private.wallet_restorations WHERE reset_id='zero-ambiguous-finance'")).rows[0].n,0);eq((await getWallet(d)).spent,160000);await reconcile();
  });
 }finally{await isolated.end();}
}
(async()=>{try{
 const admin=new Client({connectionString:adminURL.href});await admin.connect();try{await admin.query('DROP DATABASE IF EXISTS '+name+' WITH(FORCE)');await admin.query('CREATE DATABASE '+name);}finally{await admin.end();}
 for(const file of(await fs.readdir(dir)).filter(f=>/^\d+_.*\.sql$/.test(f)&&f<migration).sort())await db.query(await fs.readFile(path.join(dir,file),'utf8'));
 await db.query("INSERT INTO target_private.server_credentials(singleton,key_hash) VALUES(true,encode(sha256(convert_to($1,'UTF8')),'hex'))",[secret]);
 for(const [member,userId,totalPoints]of[[a,1,1000],[b,2,500]]){const r=await rpc('target_calculus_rpc','link',{...member,userId,totalPoints,known:true,deleted:false});ok(r.linked);}
 const bDraw=await rpc('target_shop_rpc','draw',{...b,requestId:uuid(),itemType:'sticker',expectedPrice:100000,expectedCatalogVersion:3});ok(!bDraw.error);
 await db.query("SELECT target_private.adjust_wallet_income('income_adjust_other_taka_fixture',$1::jsonb)",[JSON.stringify(manifest(b,2000000))]);
 await db.query("SELECT target_private.adjust_wallet_income('income_adjust_fixture_exact',$1::jsonb)",[JSON.stringify(manifest(a,9939920))]);
 await db.query("INSERT INTO target_private.map_purchases(member_id,request_id,request_hash,shape,color,cell_count,new_count,takeover_count,cost) VALUES($1,$2,$3,'{}',1,2301,2301,0,230100)",[a.memberId,uuid(),'b'.repeat(64)]);
 // Synthetic historical receipts cannot be created through the current public
 // 100k-only purchase API. Disable only fixture-table triggers while inserting
 // the four authentic old-price shapes; all triggers are active for every test.
 const legacyTx=await db.connect();try{await legacyTx.query('BEGIN');await legacyTx.query('ALTER TABLE target_private.sticker_draws DISABLE TRIGGER USER');for(const sticker of['youth','sunglasses','night','love'])await legacyTx.query('INSERT INTO target_private.sticker_draws(member_id,request_id,sticker_id,cost) VALUES($1,$2,$3,10000)',[a.memberId,uuid(),sticker]);await legacyTx.query('ALTER TABLE target_private.sticker_draws ENABLE TRIGGER USER');await legacyTx.query('UPDATE target_private.profiles SET spent_points=270100 WHERE member_id=$1',[a.memberId]);await legacyTx.query('COMMIT');}catch(e){await legacyTx.query('ROLLBACK');throw e;}finally{legacyTx.release();}
 const cutoff=(await db.query('SELECT clock_timestamp()::text at')).rows[0].at,baseline=(await db.query('SELECT target_private.wallet_finance_snapshot() v')).rows[0].v;
 const base=await db.query("SELECT target_private.restore_wallet_finances('zero-wallet-fixture-base',$1,$2::jsonb,$3) v",[cutoff,JSON.stringify(baseline),'c'.repeat(64)]);ok(!base.rows[0].v.replayed);
 await seedDraws(a,4);const oldVoid=(await db.query("SELECT target_private.restore_inventory('zero-wallet-prior-four-voids',$1,'zero-wallet-fixture-base') v",[cutoff])).rows[0].v;eq(oldVoid.voidedDraws,4);eq(oldVoid.additionalRefund,400000);
 const drawIds=await seedDraws(a,52);await projection();eq((await wallet(a)).spent,5470100);eq((await wallet(a)).totalIncome,9939920);eq((await wallet(a)).drawCount,60);eq((await wallet(a)).voidedDrawCount,4);eq((await wallet(a)).refundedSpend,400000);
 await db.query("CREATE OR REPLACE FUNCTION target_private.reward_points_for_roll(p_roll integer) RETURNS integer LANGUAGE sql IMMUTABLE STRICT SECURITY INVOKER SET search_path=pg_catalog AS 'SELECT 1000'");
 const originalInventory=(await db.query("SELECT pg_get_functiondef('target_private.restore_inventory(text,timestamptz,text)'::regprocedure) v")).rows[0].v;
 await db.query(originalInventory.replace('FUNCTION target_private.restore_inventory(', 'FUNCTION target_private.zero_wallet_old_restore_inventory('));
 const beforeInstall=await histories(),beforeA=await profile(a),beforeB=await profile(b);
 await phase('installation preserves financial state, receipts, source watermarks and other members',async()=>{
  const sql=await fs.readFile(path.join(dir,migration),'utf8');ok(sql.trim().length>0,'The zero-wallet migration is complete');await db.query(sql);
  eq(await histories(),beforeInstall);eq(await profile(a),beforeA);eq(await profile(b),beforeB);await projection();
 });
 let originalWallet,afterWallet;
 await phase('exact requested totals become4m gross,4m spending and0 balance without removing items',async()=>{
  originalWallet=await wallet(a);const h=await histories();const result=await apply(operation,request);ok(!result.replayed);afterWallet=await wallet(a);
  eq(afterWallet.totalIncome,4000000);eq(afterWallet.spent,4000000);eq(afterWallet.balance,0);eq(afterWallet.walletRevision,originalWallet.walletRevision+1);
  eq(afterWallet.drawCount,60);eq(afterWallet.ownedStickers,originalWallet.ownedStickers);eq(afterWallet.stickerQuantities,originalWallet.stickerQuantities);eq(afterWallet.refundedSpend,1870100);
  eq(afterWallet.voidedDrawCount,4);eq(afterWallet.legacyDiscountedDraws,4);eq(afterWallet.mapSpent,230100);shop.validateWallet(afterWallet);checks++;eq(await histories(),h);eq(await profile(b),beforeB);await projection();
  const rows=(await db.query('SELECT amount FROM target_private.manual_receipt_writeoffs WHERE reset_id=$1 ORDER BY amount',[operation])).rows.map(r=>Number(r.amount));
  eq(rows.length,15);eq(rows[0],70100);eq(rows.filter(n=>n===100000).length,14);eq(rows.reduce((sum,n)=>sum+n,0),1470100);
 });
 await phase('same-operation and concurrent retries cannot reapply the adjustment',async()=>{
  const results=await Promise.all(Array.from({length:12},()=>apply(operation,request)));ok(results.every(r=>r.replayed));eq(await wallet(a),afterWallet);
  eq((await db.query('SELECT count(*)::integer n FROM target_private.wallet_restorations WHERE reset_id=$1',[operation])).rows[0].n,1);
  const changed=manifest(a,4000100);await rejectedMutation(()=>apply(operation,changed),'22023');eq(await wallet(a),afterWallet);
 });
 await phase('accepted purchase retry and new study/source income retain coherent ownership and money',async()=>{
  const replay=await rpc('target_shop_rpc','draw',{...a,requestId:drawIds[0],itemType:'sticker',expectedPrice:100000,expectedCatalogVersion:3});ok(!replay.error);eq(await wallet(a),afterWallet);shop.validateWallet(replay);checks++;
  const newDraw=await rpc('target_shop_rpc','draw',{...a,requestId:uuid(),itemType:'frame',expectedPrice:100000,expectedCatalogVersion:3});eq(newDraw.error.code,'INSUFFICIENT_BALANCE');eq(await wallet(a),afterWallet);
  const earned=await earn(a);eq(earned.awardPoints,1000);const afterEarn=await wallet(a);eq(afterEarn.totalIncome,4001000);eq(afterEarn.balance,1000);eq((await apply(operation,request)).replayed,true);eq(await wallet(a),afterEarn);
  const oldSync=await rpc('target_calculus_rpc','sync',{totals:[{userId:1,totalPoints:1000,known:true,deleted:false}]});eq(oldSync.synced,0);eq(await wallet(a),afterEarn);
  const sync=await rpc('target_calculus_rpc','sync',{totals:[{userId:1,totalPoints:1001,known:true,deleted:false}]});eq(sync.synced,1);eq((await wallet(a)).balance,11000);eq((await apply(operation,request)).replayed,true);await projection();
 });
 await phase('immutable writeoff records cannot be changed or extended without matching ledger authority',async()=>{
  await rejectedMutation(()=>db.query('UPDATE target_private.manual_receipt_writeoffs SET amount=amount WHERE reset_id=$1',[operation]),'42501');
  await rejectedMutation(()=>db.query('DELETE FROM target_private.manual_receipt_writeoffs WHERE reset_id=$1',[operation]),'42501');
  const untouched=(await db.query('SELECT d.request_id FROM target_private.item_draws d WHERE d.member_id=$1 AND NOT EXISTS(SELECT 1 FROM target_private.manual_receipt_writeoffs w WHERE w.member_id=d.member_id AND w.request_id=d.request_id) LIMIT 1',[a.memberId])).rows[0].request_id;
  const before=await wallet(a);await rejectedMutation(()=>db.query('INSERT INTO target_private.manual_receipt_writeoffs(reset_id,member_id,request_id,amount) VALUES($1,$2,$3,100)',[operation,a.memberId,untouched]));eq(await wallet(a),before);await projection();
 });
 await phase('exhausted audit capacity rejects the complete financial operation atomically',async()=>{
  const before=await wallet(a),h=await histories(),old=(await db.query('SELECT logical_bytes FROM target_private.system_state WHERE singleton')).rows[0].logical_bytes;
  await db.query('UPDATE target_private.system_state SET logical_bytes=104857600 WHERE singleton');
  try{await rejectedMutation(()=>apply('zero_income_capacity',manifest(a,3900000)),'54000');eq(await wallet(a),before);eq(await histories(),h);eq((await db.query("SELECT count(*)::integer n FROM target_private.wallet_restoration_events WHERE reset_id='zero_income_capacity'")).rows[0].n,0);}finally{await db.query('UPDATE target_private.system_state SET logical_bytes=$1 WHERE singleton',[old]);}await projection();
 });
 await phase('already-compiled binary refund logic cannot silently skip or overpay partial receipts',async()=>{
  const before=await wallet(a),client=await db.connect();try{await client.query('BEGIN');let denied=false;try{await client.query("SELECT target_private.zero_wallet_old_restore_inventory('zero-wallet-old-unsafe',$1,'zero-wallet-fixture-base')",[cutoff]);await client.query('COMMIT');}catch(error){denied=true;await client.query('ROLLBACK');}ok(denied,'The retired binary refund implementation is fenced');}finally{client.release();}
  eq(await wallet(a),before);eq((await db.query("SELECT count(*)::integer n FROM target_private.inventory_restoration_events WHERE reset_id='zero-wallet-old-unsafe'")).rows[0].n,0);await projection();
 });
 let restoredWallet;
 await phase('a genuine later inventory restoration refunds only29900 on the partially written-off receipt',async()=>{
  const result=(await db.query("SELECT target_private.restore_inventory('zero-wallet-future-inventory',$1,'zero-wallet-fixture-base') v",[cutoff])).rows[0].v;
  eq(result.voidedDraws,52);eq(result.additionalRefund,3729900);restoredWallet=await wallet(a);eq(restoredWallet.spent,270100);eq(restoredWallet.balance,3740900);eq(restoredWallet.totalIncome,4011000);eq(restoredWallet.ownedStickers,['youth','sunglasses','night','love']);eq(restoredWallet.voidedDrawCount,56);shop.validateWallet(restoredWallet);checks++;
  const partial=(await db.query("SELECT count(*)::integer n FROM target_private.inventory_voids WHERE member_id=$1 AND additional_refund=29900",[a.memberId])).rows[0].n;eq(partial,1);
  const full=(await db.query("SELECT count(*)::integer n FROM target_private.inventory_voids WHERE member_id=$1 AND additional_refund=0",[a.memberId])).rows[0].n;eq(full,14);await projection();
 });
 await phase('future purchases and all prior operation replays preserve their exact later wallet',async()=>{
  const purchase=await rpc('target_shop_rpc','draw',{...a,requestId:uuid(),itemType:'frame',expectedPrice:100000,expectedCatalogVersion:3});ok(!purchase.error);const current=await wallet(a);shop.validateWallet(current);checks++;
  eq((await apply(operation,request)).replayed,true);eq((await db.query("SELECT target_private.restore_inventory('zero-wallet-future-inventory',$1,'zero-wallet-fixture-base') v",[cutoff])).rows[0].v.replayed,true);eq(await wallet(a),current);
  const voided=await rpc('target_shop_rpc','draw',{...a,requestId:drawIds[0],itemType:'sticker',expectedPrice:100000,expectedCatalogVersion:3});ok(!voided.error);eq(voided.receiptVoided,true);eq(await wallet(a),current);await projection();
 });
 await phase('a fresh financial restoration after the writeoff can refund a later purchase exactly once',async()=>{
  const before=await wallet(a),at=(await db.query('SELECT clock_timestamp()::text at')).rows[0].at;
  const draw=await rpc('target_shop_rpc','draw',{...a,requestId:uuid(),itemType:'frame',expectedPrice:100000,expectedCatalogVersion:3});ok(!draw.error);eq(draw.spent,before.spent+100000);
  const snapshot=(await db.query('SELECT target_private.wallet_finance_snapshot() v')).rows[0].v;
  const restore=()=>db.query("SELECT target_private.restore_wallet_finances('zero-wallet-future-finance',$1,$2::jsonb,$3) v",[at,JSON.stringify(snapshot),'d'.repeat(64)]).then(r=>r.rows[0].v);
  eq((await restore()).replayed,false);const restored=await wallet(a);eq(restored.totalIncome,before.totalIncome);eq(restored.spent,before.spent);eq(restored.balance,before.balance);eq(restored.refundedSpend,before.refundedSpend+100000);shop.validateWallet(restored);checks++;await projection();
  await earn(a);const later=await wallet(a);eq((await restore()).replayed,true);eq((await apply(operation,request)).replayed,true);eq(await wallet(a),later);await projection();
 });
 await phase('invalid identity, infeasible targets and rollback never leave partial corrections',async()=>{
  const before=await wallet(a),h=await histories();for(const body of[manifest({...a,name:'違う人'},4000000),manifest(a,100),manifest(a,4000010),manifest({...a,memberId:uuid()},4000000)])await rejectedMutation(()=>apply('zero_income_invalid',body));eq(await wallet(a),before);eq(await histories(),h);
  const tx=await db.connect();try{await tx.query('BEGIN');const body=manifest(a,270100);await apply('zero_income_rollback',body,tx);await tx.query('ROLLBACK');}finally{tx.release();}eq(await wallet(a),before);eq((await db.query("SELECT count(*)::integer n FROM target_private.wallet_restoration_events WHERE reset_id='zero_income_rollback'")).rows[0].n,0);await projection();
 });
 await phase('new private accounting helpers and tables are inaccessible to application roles',async()=>{
  eq((await db.query("SELECT has_function_privilege('anon','target_private.zero_wallet_income(text,jsonb)','EXECUTE') anon,has_function_privilege('authenticated','target_private.zero_wallet_income(text,jsonb)','EXECUTE') authenticated,has_function_privilege('service_role','target_private.zero_wallet_income(text,jsonb)','EXECUTE') service")).rows[0],{anon:false,authenticated:false,service:false});
  eq((await db.query("SELECT relrowsecurity,has_table_privilege('anon','target_private.manual_receipt_writeoffs','SELECT') anon,has_table_privilege('authenticated','target_private.manual_receipt_writeoffs','INSERT') authenticated FROM pg_class WHERE oid='target_private.manual_receipt_writeoffs'::regclass")).rows[0],{relrowsecurity:true,anon:false,authenticated:false});
 });
 await criticalOverlapCases();
 const report={status:'passed',checks,phases,hostedWrites:0,exactFixture:{originalTotal:9939920,originalSpend:5470100,targetTotal:4000000,targetSpend:4000000,writeoff:1470100,mapExpensePreserved:230100,legacyReceipts:4,priorVoidedReceipts:4,originalDrawCount:60,retainedActiveQuantity:56},partialReceiptResidual:29900};
 await fs.writeFile(process.env.ZERO_WALLET_INDEPENDENT_REPORT||'/workspace/scratch/zero-wallet-independent-results.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
 }finally{await db.end();}
})().catch(e=>{console.error('Independent zero-wallet verification failed: '+String(e.stack||e).replaceAll(secret,'[redacted]'));process.exitCode=1;});
