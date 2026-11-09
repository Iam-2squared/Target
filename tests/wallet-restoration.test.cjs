'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {prepare}=require('../scripts/prepare-wallet-restoration.cjs');
function manifest(){const core={version:1,resetId:'local_fixture',walletCutoff:'2026-11-08T23:00:00Z',policy:'all_lifetime_through_operation_snapshot',sourceCapturedAt:'2026-11-09T06:30:00Z',targetCapturedAt:'2026-11-09T06:29:59Z',sourceBaselines:[{userId:1,totalPoints:4,deleted:true}],newRanges:[{resetId:'local_fixture',userId:1,sourceFrom:0,sourceTo:4}],validationErrors:[]};return{...core,manifestSha256:crypto.createHash('sha256').update(JSON.stringify(core)).digest('hex')};}
test('wallet restoration preparation binds a frozen source manifest to one atomic private operation',()=>{
 const value=manifest(),result=prepare(value);assert.match(result.apply,/BEGIN;[\s\S]*apply_wallet_restoration[\s\S]*COMMIT;/);assert.match(result.apply,/"sourceFrom":0,"sourceTo":4/);assert.match(result.apply,/"userId":1,"totalPoints":4,"deleted":true/);assert(result.apply.includes(value.manifestSha256));assert.match(result.preview,/SELECT ONLY/);assert(!/\b(BEGIN|INSERT|UPDATE|DELETE|COMMIT)\b/.test(result.preview));assert.match(result.rehearsal,/ROLLBACK;/);assert(!result.rehearsal.includes('COMMIT;'));
});
test('wallet restoration preparation rejects edited manifests or unsuccessful source plans',()=>{
 const edited=manifest();edited.sourceBaselines[0].totalPoints++;assert.throws(()=>prepare(edited),/SHA-256/);const failed=manifest();delete failed.manifestSha256;failed.validationErrors=['stale'];failed.manifestSha256=crypto.createHash('sha256').update(JSON.stringify(failed)).digest('hex');assert.throws(()=>prepare(failed),/unsuccessful/);
});
