'use strict';
// Pure local file preparation. This script never connects to a database.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
function prepare(manifest){
  const {manifestSha256,...core}=manifest;
  if(!/^[a-f0-9]{64}$/.test(manifestSha256||'')||crypto.createHash('sha256').update(JSON.stringify(core)).digest('hex')!==manifestSha256)throw Error('Frozen manifest SHA-256 does not match its exact contents.');
  if(manifest.version!==1||manifest.policy!=='all_lifetime_through_operation_snapshot'||!/^[a-zA-Z0-9_-]{1,80}$/.test(manifest.resetId||'')||!Array.isArray(manifest.validationErrors)||manifest.validationErrors.length)throw Error('Invalid or unsuccessful source restoration plan.');
  for(const key of['walletCutoff','sourceCapturedAt'])if(typeof manifest[key]!=='string'||!Number.isFinite(Date.parse(manifest[key])))throw Error('Invalid restoration timestamp.');
  if(Date.parse(manifest.walletCutoff)>Date.parse(manifest.sourceCapturedAt)||!Array.isArray(manifest.sourceBaselines)||!Array.isArray(manifest.newRanges))throw Error('Invalid source restoration inputs.');
  const baselines=manifest.sourceBaselines.map(row=>({userId:row.userId,totalPoints:row.totalPoints,deleted:row.deleted}));
  const ranges=manifest.newRanges.map(row=>{if(row.resetId!==manifest.resetId)throw Error('Source range belongs to a different operation.');return{userId:row.userId,sourceFrom:row.sourceFrom,sourceTo:row.sourceTo};});
  const literal=value=>"'"+String(value).replace(/'/g,"''")+"'";
  // JST source date is provenance metadata; exclusions use monotonic lifetime indices.
  const sourceDay=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(manifest.sourceCapturedAt));
  const call=`SELECT target_private.apply_wallet_restoration(${literal(manifest.resetId)},${literal(manifest.walletCutoff)}::timestamptz,${literal(sourceDay)}::date,${literal(manifest.sourceCapturedAt)}::timestamptz,${literal(manifestSha256)},${literal(JSON.stringify(ranges))}::jsonb,${literal(JSON.stringify(baselines))}::jsonb) AS restoration;`;
  const intro=`-- Frozen operation ${manifest.resetId}\n-- Manifest SHA256 ${manifestSha256}\n-- Run only after compatible Target/KGS clients and the restoration migration are ready.\n-- Existing completed reset ID/hash returns immediately before any source exclusion writes.\n`;
  const verify=`SELECT count(*) AS component_mismatches FROM target_private.wallet_finance_projection(NULL) l JOIN target_private.profiles p USING(member_id) WHERE (p.total_points,p.spent_points,p.calculus_points,p.birthday_points,p.casino_net,p.calculus_forgiven_points) IS DISTINCT FROM (l.total_points,l.spent_points,l.calculus_points,l.birthday_points,l.casino_net,l.calculus_forgiven_points);\nSELECT reset_id,member_count,source_manifest_sha256,created_at FROM target_private.wallet_restoration_events WHERE reset_id=${literal(manifest.resetId)};\nSELECT sum((restored_state->>'totalPoints')::bigint) AS total_income,sum((restored_state->>'spentPoints')::bigint) AS spent,sum((restored_state->>'totalPoints')::bigint-(restored_state->>'spentPoints')::bigint) AS balance,sum(spent_refund) AS refunded_spend FROM target_private.wallet_restorations WHERE reset_id=${literal(manifest.resetId)};\n`;
  const apply=intro+"BEGIN;\nSET LOCAL lock_timeout='15s';\nSET LOCAL statement_timeout='90s';\n"+call+'\n'+verify+'COMMIT;\n';
  // The preview executes the EXACT operation locally/in a rollback transaction.
  // A pure SELECT candidate file is also generated for genuinely read-only review.
  const rehearsal=intro+"BEGIN;\nSET LOCAL lock_timeout='15s';\nSET LOCAL statement_timeout='90s';\n"+call+'\n'+verify+'ROLLBACK;\n';
  const preview=intro+`-- SELECT ONLY; does not synchronize, grant, void, or restore anything.\nSELECT member_id,total_points,spent_points,total_points-spent_points AS balance,calculus_points,birthday_points,casino_net,calculus_forgiven_points,raw_study_points,map_spent FROM target_private.wallet_finance_projection(${literal(manifest.walletCutoff)}::timestamptz) ORDER BY member_id;\nSELECT reset_id,member_count,source_manifest_sha256,created_at FROM target_private.wallet_restoration_events WHERE reset_id=${literal(manifest.resetId)};\n`;
  return{apply,rehearsal,preview,manifestSha256};
}
if(require.main===module){
  try{
    const [sourcePath,directory]=process.argv.slice(2);if(!sourcePath||!directory)throw Error('Usage: node scripts/prepare-wallet-restoration.cjs frozen-manifest.json output-directory');
    const manifest=JSON.parse(fs.readFileSync(sourcePath,'utf8')),output=prepare(manifest);fs.mkdirSync(directory,{recursive:true});
    const prefix=path.join(directory,'wallet-restore-'+manifest.resetId),frozen=JSON.stringify(manifest,null,2)+'\n';
    const files={'.manifest.json':frozen,'.apply.sql':output.apply,'.rehearsal.sql':output.rehearsal,'.preview.sql':output.preview};
    for(const[suffix,contents]of Object.entries(files)){const dest=prefix+suffix;if(fs.existsSync(dest)&&fs.readFileSync(dest,'utf8')!==contents)throw Error('Refusing to replace an existing operation with a different frozen manifest or SQL.');}
    for(const[suffix,contents]of Object.entries(files))if(!fs.existsSync(prefix+suffix))fs.writeFileSync(prefix+suffix,contents,{flag:'wx'});
    console.log(JSON.stringify({prepared:true,resetId:manifest.resetId,manifestSha256:output.manifestSha256,files:Object.keys(files).map(suffix=>prefix+suffix),databaseWrites:false}));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
module.exports={prepare};
