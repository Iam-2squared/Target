'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const birthday=require('../server/birthday.cjs');
const valid=amount=>({gift:{giftYear:2026,birthdayDate:'2026-11-11',amount,seen:false}});
test('Target accepts 1,000,000-todo birthday gifts without rewriting old 100k receipts',()=>{
 assert.equal(birthday.AMOUNT,1000000);
 assert.deepEqual(birthday.parseStatus(valid(1000000)),valid(1000000));
 assert.deepEqual(birthday.parseStatus(valid(100000)),valid(100000));
 assert.deepEqual(birthday.parseStatus({gift:{...valid(100000).gift,birthdayDate:'2026-11-10'}}).gift.amount,100000);
 for(const amount of [1,900000,2000000,'1000000'])assert.throws(()=>birthday.parseStatus(valid(amount)));
 assert.throws(()=>birthday.parseStatus({gift:{...valid(1000000).gift,birthdayDate:'2026-11-10'}}));
});
test('one-million migration is signed, idempotent and retains old receipt audit proof',()=>{
 const sql=fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261111061500_target_birthday_million_upgrade.sql'),'utf8');
 for(const token of ['CREATE TABLE IF NOT EXISTS target_private.birthday_upgrades',
 'PRIMARY KEY(member_id,gift_year)','FOREIGN KEY(member_id,gift_year)',
 'CHECK(amount=900000)','ENABLE ROW LEVEL SECURITY','REVOKE ALL ON target_private.birthday_upgrades',
 'birthday_upgrade_immutable','WHERE r.birthday_date >= DATE \'2026-11-11\' AND r.amount=100000',
 'ON CONFLICT DO NOTHING','gift_amount:=CASE WHEN birthday_value>=DATE \'2026-11-11\' THEN 1000000 ELSE 100000 END',
 'UPDATE target_private.birthday_upgrades SET seen_at',
 'UNION ALL SELECT member_id,amount,created_at FROM target_private.birthday_upgrades',
 'birthday_points=birthday_points+900000'])assert(sql.includes(token),'missing '+token);
 assert(!/UPDATE target_private\.birthday_receipts SET amount/.test(sql),'Historical receipts must be immutable');
});
