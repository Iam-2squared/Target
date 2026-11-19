'use strict';
// Real PostgreSQL assertions against synthetic accounts in a disposable local DB.
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs/promises'),path=require('node:path');
const {Client}=require('pg'),shop=require('../server/shop.cjs');
const uuid=()=>crypto.randomUUID(),secret=crypto.randomBytes(32).toString('base64url');
const dbName='photo_stickers_'+process.pid+'_'+crypto.randomBytes(4).toString('hex')+'_test';
const member={memberId:uuid(),name:'写真スタンプ検証'},fresh={memberId:uuid(),name:'旧画面拒否'};
let admin,db,created=false,checks=0;
const eq=(a,b,label)=>{checks++;assert.deepEqual(a,b,label);};
const ok=(v,label)=>{checks++;assert.ok(v,label);};
async function rpc(action,input,key=secret){return(await db.query('SELECT public.target_shop_rpc($1,$2,$3::jsonb) AS value',[key,action,JSON.stringify(input)])).rows[0].value;}
async function wallet(){return(await db.query('SELECT target_private.wallet_snapshot($1) AS value',[member.memberId])).rows[0].value;}
async function draw(itemType='sticker',requestId=uuid(),version=5){await db.query('DELETE FROM target_private.rate_limits');return rpc('draw',{...member,requestId,itemType,expectedPrice:100000,expectedCatalogVersion:version});}
async function state(){const result={};const tables=(await db.query("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='target_private' AND c.relkind='r' AND c.relname<>'sticker_catalog' ORDER BY c.relname")).rows;for(const {relname} of tables)result[relname]=(await db.query('SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),\'[]\') AS value FROM target_private.'+relname+' t')).rows[0].value;return result;}
async function main(){
  eq(process.env.NODE_ENV,'test');const url=new URL(process.env.DATABASE_URL||'');ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname)&&!url.search&&!url.hash,'loopback only');
  const adminUrl=new URL(url);adminUrl.pathname='/postgres';admin=new Client({connectionString:adminUrl.href});await admin.connect();await admin.query('CREATE DATABASE "'+dbName+'"');created=true;url.pathname='/'+dbName;db=new Client({connectionString:url.href});await db.connect();
  await db.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF; END $$");
  const dir=path.resolve(__dirname,'../supabase/migrations'),files=(await fs.readdir(dir)).filter(f=>/^\d+_.*\.sql$/.test(f)).sort(),retirement=files.find(f=>f.endsWith('_target_retire_stickers_refund.sql')),migration=files.find(f=>f.endsWith('_target_photo_sticker_catalog.sql'));
  ok(retirement&&migration);for(const file of files.filter(f=>f<retirement))await db.query(await fs.readFile(path.join(dir,file),'utf8'));
  await db.query("INSERT INTO target_private.server_credentials(singleton,key_hash) VALUES(true,encode(sha256(convert_to($1,'UTF8')),'hex'))",[secret]);
  ok(!(await rpc('wallet',member)).error);
  const funded=(await db.query('SELECT target_private.adjust_wallet_income($1,$2::jsonb) AS value',['income_adjust_photo_fixture',JSON.stringify({version:1,reason:'Local synthetic photo catalog fixture',targets:[{memberId:member.memberId,expectedName:member.name,totalIncome:10000000}]})])).rows[0].value;ok(!funded.error);
  const old=await draw('sticker',uuid(),3),frame=await draw('frame',uuid(),3);ok(!old.error&&!frame.error);
  const oldLegacyId=uuid();await db.query('BEGIN');await db.query('ALTER TABLE target_private.sticker_draws DISABLE TRIGGER USER');await db.query("INSERT INTO target_private.sticker_draws(member_id,request_id,sticker_id,cost) VALUES($1,$2,'youth',10000)",[member.memberId,oldLegacyId]);await db.query('ALTER TABLE target_private.sticker_draws ENABLE TRIGGER USER');await db.query('UPDATE target_private.profiles SET spent_points=spent_points+10000 WHERE member_id=$1',[member.memberId]);await db.query('COMMIT');
  for(const file of files.filter(f=>f>=retirement&&f<migration))await db.query(await fs.readFile(path.join(dir,file),'utf8'));
  const before=await state(),beforeWallet=await wallet();eq(beforeWallet.catalogVersion,4);eq(beforeWallet.refundedSpend,110000);eq(beforeWallet.voidedDrawCount,2);eq(beforeWallet.ownedStickers,[]);
  const oldDef=(await db.query("SELECT pg_get_functiondef('public.target_shop_rpc(text,text,jsonb)'::regprocedure) AS value")).rows[0].value;await db.query(oldDef.replace('FUNCTION public.target_shop_rpc(','FUNCTION target_private.photo_cached_shop_fixture('));await db.query('REVOKE ALL ON FUNCTION target_private.photo_cached_shop_fixture(text,text,jsonb) FROM PUBLIC,anon,authenticated,service_role');
  const migrationSql=await fs.readFile(path.join(dir,migration),'utf8');
  const oldLogical=(await db.query('SELECT logical_bytes FROM target_private.system_state WHERE singleton')).rows[0].logical_bytes;
  await db.query('UPDATE target_private.system_state SET logical_bytes=104857600-2816+1 WHERE singleton');
  const beforeQuota=await state();await assert.rejects(db.query(migrationSql),error=>error.code==='54000');checks++;await db.query('ROLLBACK');eq(await state(),beforeQuota,'catalog quota rejection rolls back all state');eq((await db.query('SELECT count(*)::int AS n FROM target_private.sticker_catalog')).rows[0].n,17,'quota rejection rolls back new catalog rows');
  await db.query('UPDATE target_private.system_state SET logical_bytes=$1 WHERE singleton',[oldLogical]);
  await db.query(migrationSql);const expectedState=structuredClone(before);expectedState.system_state[0].logical_bytes=Number(expectedState.system_state[0].logical_bytes)+2816;eq(await state(),expectedState,'only the exact11-row catalog storage charge changes; balances, receipts, frames, counters, audits and timestamps stay intact');
  const current=await wallet();const expected={...beforeWallet,catalogVersion:5,catalogSize:11};delete expected.stickersRetired;eq(current,expected);eq(shop.validateWallet(current),current);
  for(const [requestId,cost] of [[old.requestId,100000],[oldLegacyId,10000]]){const replay=await draw('sticker',requestId,3);eq(replay.quantity,0);eq(replay.cost,cost);eq(replay.receiptVoided,true);shop.validateWallet(replay,{requestId});checks++;}
  const frameReplay=await draw('frame',frame.requestId,4);eq(frameReplay.quantity,1);eq(frameReplay.frameId,frame.frameId);shop.validateWallet(frameReplay,{requestId:frame.requestId,itemType:'frame'});checks++;
  for(const version of [1,2,3,4]){const baseline=await state(),denied=await rpc('draw',{...fresh,requestId:uuid(),itemType:'sticker',expectedPrice:100000,expectedCatalogVersion:version});eq(denied.error?.code,'CATALOG_CHANGED');eq(await state(),baseline,'stale photo purchases allocate and charge nothing');}
  const beforeForbidden=await state();eq((await rpc('draw',{...member,requestId:uuid(),itemType:'sticker',expectedPrice:100000,expectedCatalogVersion:5},'x'.repeat(32))).error?.code,'RPC_FORBIDDEN');eq(await state(),beforeForbidden);
  const randomDef=(await db.query("SELECT pg_get_functiondef('target_private.secure_random_int(integer)'::regprocedure) AS value")).rows[0].value;await db.query('CREATE SEQUENCE target_private.photo_fixture_entropy MINVALUE 0 START 0');await db.query("CREATE OR REPLACE FUNCTION target_private.secure_random_int(p_bound integer) RETURNS integer LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$ SELECT CASE WHEN p_bound=11 THEN (nextval('target_private.photo_fixture_entropy')%11)::integer ELSE 0 END $$");
  const receipts=[];for(let i=0;i<12;i++){const result=await draw();ok(!result.error,'photo purchase accepted');eq(result.cost,100000);eq(result.catalogVersion,5);eq(result.catalogSize,11);ok(shop.ACTIVE_STICKERS.includes(result.stickerId));shop.validateWallet(result,{requestId:result.requestId});checks++;receipts.push(result);}
  eq(receipts.slice(0,11).map(r=>r.stickerId),shop.ACTIVE_STICKERS,'uniform integer11 draw covers exactly the new11 designs');eq(receipts[11].stickerId,receipts[0].stickerId);eq(receipts[11].quantity,2,'duplicates remain purchased copies');
  await db.query(randomDef);await db.query('DROP SEQUENCE target_private.photo_fixture_entropy');
  const balanceBeforeReplay=(await wallet()).balance;const repeated=await draw('sticker',receipts[0].requestId,4);eq(repeated.stickerId,receipts[0].stickerId);eq(repeated.quantity,2);eq((await wallet()).balance,balanceBeforeReplay,'receipt retry never charges twice');
  const conflict=await draw('frame',receipts[0].requestId,5);eq(conflict.error?.code,'REQUEST_ID_CONFLICT');eq((await wallet()).balance,balanceBeforeReplay);
  const newFrame=await draw('frame');ok(!newFrame.error);eq(newFrame.frameCatalogSize,33);eq(newFrame.frameOdds,shop.FRAME_ODDS);shop.validateWallet(newFrame,{requestId:newFrame.requestId,itemType:'frame'});checks++;
  const checkOld=async(sql,values)=>{await db.query('BEGIN');try{await assert.rejects(db.query(sql,values),error=>error.code==='42501');checks++;}finally{await db.query('ROLLBACK');}};
  await checkOld('SELECT target_private.photo_cached_shop_fixture($1,$2,$3::jsonb)',[secret,'draw',JSON.stringify({...member,requestId:uuid(),itemType:'frame',expectedPrice:100000,expectedCatalogVersion:4})]);
  await db.query('BEGIN');await db.query("SET LOCAL target.gacha_catalog_protocol='5'; SET LOCAL target.gacha_price_protocol='100000'; SET LOCAL target.gacha_inventory_protocol='active-v1'");await assert.rejects(db.query("INSERT INTO target_private.item_draws(member_id,request_id,item_type,sticker_id,cost) VALUES($1,$2,'sticker','youth',100000)",[member.memberId,uuid()]),error=>error.code==='42501');checks++;await db.query('ROLLBACK');
  const afterWallet=await wallet();eq(afterWallet.totalIncome,beforeWallet.totalIncome);eq(afterWallet.spent,beforeWallet.spent+1300000);eq(afterWallet.balance,beforeWallet.balance-1300000);eq(afterWallet.refundedSpend,beforeWallet.refundedSpend);eq(afterWallet.voidedDrawCount,2);eq(afterWallet.legacyDiscountedDraws,1);
  const verified=await db.query(await fs.readFile(path.resolve(__dirname,'../supabase/tests/target_photo_sticker_catalog_verify.sql'),'utf8'));ok(verified.some(r=>r.rows.some(v=>v.result==='target_photo_sticker_catalog_postflight_passed')));
  console.log(JSON.stringify({status:'passed',assertions:checks,hostedWrites:0,database:dbName}));
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{if(db)await db.end().catch(()=>{});if(admin){if(created)await admin.query('DROP DATABASE "'+dbName+'" WITH (FORCE)').catch(()=>{});await admin.end().catch(()=>{});}});
