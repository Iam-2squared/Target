'use strict';
// A disposable loopback PostgreSQL database; never the hosted Target ledger.
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs/promises');
const path=require('node:path');
const {Client}=require('pg');
const root=path.resolve(__dirname,'..'),name='target_mastery_badges_'+process.pid,uuid=()=>crypto.randomUUID();
const secret=crypto.randomBytes(40).toString('hex');
let admin,db,created=false,checks=0;
const eq=(a,b,description)=>{checks++;assert.deepEqual(a,b,description)};
const ok=(value,description)=>{checks++;assert(value,description)};
const p={memberId:uuid(),name:'Mastery Member'},another={memberId:uuid(),name:'Another'};
async function rpc(member=p,credentials=secret,action='list'){
 return (await db.query('SELECT public.target_badge_rpc($1,$2,$3::jsonb) r',
  [credentials,action,JSON.stringify(member)])).rows[0].r;
}
async function award(member,book,first,last){
 for(let n=first;n<=last;n++)await db.query(
  'INSERT INTO target_private.section_mastery_achievements(member_id,book,section,recorded_from) VALUES($1,$2,$3,$4)',
  [member.memberId,book,n,'answer']);
}
async function main(){
 eq(process.env.NODE_ENV,'test','never access hosted data');
 const url=new URL(process.env.DATABASE_URL||'');
 ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname)&&!url.search&&!url.hash,'loopback-only DB');
 const owner=new URL(url);owner.pathname='/postgres';
 admin=new Client({connectionString:owner.href});await admin.connect();
 await admin.query('CREATE DATABASE "'+name+'"');created=true;
 url.pathname='/'+name;db=new Client({connectionString:url.href});await db.connect();
 await db.query("DO $roles$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF; END $roles$");
 const dir=path.join(root,'supabase/migrations');
 for(const file of (await fs.readdir(dir)).filter(n=>/^\d+_.*\.sql$/.test(n)).sort())
  await db.query(await fs.readFile(path.join(dir,file),'utf8'));
 await db.query("INSERT INTO target_private.server_credentials(singleton,key_hash) VALUES(true,encode(sha256(convert_to($1,'UTF8')),'hex'))",[secret]);
 for(const m of [p,another])await db.query('INSERT INTO target_private.profiles(member_id,name) VALUES($1,$2)',[m.memberId,m.name]);
 const original=(await db.query('SELECT logical_bytes FROM target_private.system_state WHERE singleton')).rows[0].logical_bytes;
 const noSecret=await rpc(p,'wrong','list');eq(noSecret.error.code,'RPC_FORBIDDEN');
 const noAction=await rpc(p,secret,'edit');eq(noAction.error.code,'INVALID_REQUEST');
 const injected=await rpc({...p,role:'admin'});eq(injected.error.code,'INVALID_REQUEST');
 eq((await rpc()).earnedIds,[],'no fake unearned badges');
 await award(another,'target1900',1,1);
 eq((await rpc()).earnedIds,[],'other member achievements never shared');
 await award(p,'target1900',1,1);
 let state=await rpc();
 eq(state.earnedIds,['sec:target1900:01']);eq(state.completedSections,1);eq(state.sectionTotal,33);
 await award(p,'target1900',2,18);
 state=await rpc();
 eq(state.earnedIds.length,18,'not full-book before section19');
 ok(!state.earnedIds.includes('book:target1900'),'book badge protected');
 await award(p,'target1900',19,19);
 state=await rpc();
 eq(state.earnedIds.at(-1),'book:target1900');eq(state.earnedIds.length,20);
 await award(p,'target1000',1,10);
 state=await rpc();ok(state.earnedIds.includes('book:target1000'));
 ok(!state.earnedIds.includes('grand:all'),'grandmaster blocked without Kobun');
 await award(p,'kobun400',1,3);
 state=await rpc();ok(!state.earnedIds.includes('book:kobun400'));
 await award(p,'kobun400',4,4);
 state=await rpc();
 eq(state.completedSections,33);
 eq(state.earnedIds.length,37);
 eq(state.earnedIds.at(-1),'grand:all');
 ok(['book:target1900','book:target1000','book:kobun400'].every(id=>state.earnedIds.includes(id)));
 eq((await rpc(another)).earnedIds,['sec:target1900:01'],'separate member bound by RPC actor');
 eq((await db.query('SELECT logical_bytes FROM target_private.system_state WHERE singleton')).rows[0].logical_bytes,original,'read-only badge lookup never charges or rewrites storage');
 for(const role of ['anon','authenticated','service_role']){
  ok(!(await db.query("SELECT has_table_privilege($1,'target_private.section_mastery_achievements','SELECT') allowed",[role])).rows[0].allowed,'mastery source private');
 }
 eq((await db.query("SELECT count(*)::int n FROM target_private.section_mastery_achievements WHERE member_id=$1",[p.memberId])).rows[0].n,33,'permanent canonical awards unmodified');
 console.log(JSON.stringify({masteryBadges:'passed',checks,hostedWrites:false}));
}
main().catch(e=>{console.error(e.stack||e);process.exitCode=1;}).finally(async()=>{
 if(db)await db.end();
 if(admin){if(created)await admin.query('DROP DATABASE "'+name+'"');await admin.end();}
});
