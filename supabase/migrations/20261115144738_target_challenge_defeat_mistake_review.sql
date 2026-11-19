-- Private wrong-answer snapshots support a defeat-only review across reloads.
-- No old rows, clocks, combat rules, wallet components or historical receipts change.
BEGIN;
SET LOCAL lock_timeout='15s';
SET LOCAL statement_timeout='120s';
SELECT pg_advisory_xact_lock(991101);
DO $guard$
DECLARE item record;
BEGIN
 FOR item IN SELECT * FROM (VALUES
  ('public.target_challenge_rpc(text,text,jsonb)','66e060d1532f0fa08800f30579897d9a'),
  ('target_private.challenge_dto(uuid,uuid)','f4f5f936f9d5b046b6d9baee36512532'),
  ('target_private.challenge_storage_charge()','69be621da1580b84ed1d793cc7f95737')
 ) expected(signature,digest) LOOP
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure(item.signature)) IS DISTINCT FROM item.digest THEN
   RAISE EXCEPTION 'Reviewed challenge definition changed: %',item.signature; END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='target_private.challenge_requests'::regclass
  AND conname='challenge_requests_response_check' AND
  pg_get_constraintdef(oid)='CHECK (((jsonb_typeof(response) = ''object''::text) AND (pg_column_size(response) <= 4096)))') THEN
  RAISE EXCEPTION 'Reviewed challenge receipt bound changed'; END IF;
 IF EXISTS(SELECT 1 FROM target_private.challenge_requests WHERE action='answer'
  AND response#>>'{answer,correct}'='false' AND jsonb_typeof(response#>'{answer,mistake}')='object') THEN
  RAISE EXCEPTION 'Unexpected preexisting mistake snapshots require reviewed index accounting'; END IF;
END; $guard$;
ALTER TABLE target_private.challenge_requests DROP CONSTRAINT challenge_requests_response_check;
-- A question is <=8192 bytes before storage, including the correct text twice.
-- Its prompt/meaning snapshot plus the existing bounded receipt fits within16KiB.
ALTER TABLE target_private.challenge_requests ADD CONSTRAINT challenge_requests_response_check
 CHECK(jsonb_typeof(response)='object' AND pg_column_size(response)<=16384);
CREATE INDEX challenge_mistake_run ON target_private.challenge_requests(run_id,member_id,created_at,request_id)
 WHERE action='answer' AND response#>>'{answer,correct}'='false'
  AND jsonb_typeof(response#>'{answer,mistake}')='object';

DO $patch$
DECLARE definition text; item record; marker text; finance_before text;
BEGIN
 SELECT md5(prosrc) INTO finance_before FROM pg_proc
  WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure;
 IF finance_before IS NULL THEN RAISE EXCEPTION 'Shared financial projection missing'; END IF;
 SELECT pg_get_functiondef('target_private.challenge_storage_charge()'::regprocedure) INTO definition;
 marker:=' SELECT logical_bytes INTO used FROM target_private.system_state WHERE singleton FOR UPDATE;';
 IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN
  RAISE EXCEPTION 'Challenge storage accounting marker changed'; END IF;
 EXECUTE replace(definition,marker,$storage$
 -- Reserve an additional128 bytes for each partial-index entry. Generic trigger
 -- records are inspected as JSON so unrelated challenge row types stay valid.
 IF TG_TABLE_NAME='challenge_requests' THEN
  IF TG_OP<>'DELETE' THEN
   IF to_jsonb(NEW)->>'action'='answer' AND to_jsonb(NEW)#>>'{response,answer,correct}'='false'
    AND jsonb_typeof(to_jsonb(NEW)#>'{response,answer,mistake}')='object' THEN difference:=difference+128; END IF;
  END IF;
  IF TG_OP<>'INSERT' THEN
   IF to_jsonb(OLD)->>'action'='answer' AND to_jsonb(OLD)#>>'{response,answer,correct}'='false'
    AND jsonb_typeof(to_jsonb(OLD)#>'{response,answer,mistake}')='object' THEN difference:=difference-128; END IF;
  END IF;
 END IF;
 SELECT logical_bytes INTO used FROM target_private.system_state WHERE singleton FOR UPDATE;$storage$);

 SELECT pg_get_functiondef('target_private.challenge_dto(uuid,uuid)'::regprocedure) INTO definition;
 marker:='''reward'',r.reward,''badgeAwarded'',r.badge_awarded)';
 IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN
  RAISE EXCEPTION 'Challenge defeat DTO marker changed'; END IF;
 EXECUTE replace(definition,marker,$dto$'reward',r.reward,'badgeAwarded',r.badge_awarded,
 'mistakes',CASE WHEN r.status='lost' THEN coalesce((
  SELECT jsonb_agg(jsonb_build_object('book',m.mistake->>'book','number',(m.mistake->>'number')::integer,
   'prompt',m.mistake->>'prompt','correctText',m.mistake->>'correctText') ORDER BY m.first_at,m.first_request)
  FROM (
   SELECT DISTINCT ON (q.response#>>'{answer,mistake,book}',q.response#>>'{answer,mistake,number}')
    q.response#>'{answer,mistake}' AS mistake,q.created_at AS first_at,q.request_id AS first_request
   FROM target_private.challenge_requests q
   WHERE q.run_id=r.id AND q.member_id=p_member AND q.action='answer'
    AND q.response#>>'{answer,correct}'='false' AND jsonb_typeof(q.response#>'{answer,mistake}')='object'
   ORDER BY q.response#>>'{answer,mistake,book}',q.response#>>'{answer,mistake,number}',q.created_at,q.request_id
  ) m
 ),'[]'::jsonb) ELSE '[]'::jsonb END)$dto$);

 SELECT pg_get_functiondef('public.target_challenge_rpc(text,text,jsonb)'::regprocedure) INTO definition;
 FOR item IN SELECT * FROM (VALUES
  ('accepted boolean; bonus boolean:=false; awarded boolean:=false; damage integer;',
   'accepted boolean; bonus boolean:=false; awarded boolean:=false; damage integer; mistake_data jsonb;'),
  ('RETURN (old_request.response-''run''-''wallet'')||jsonb_build_object(',
   'RETURN ((old_request.response#-''{answer,mistake}'')-''run''-''wallet'')||jsonb_build_object('),
  ('damage:=10;enemy_heal:=least(10,100*r.level-r.enemy_hp);',
   'damage:=10;enemy_heal:=least(10,100*r.level-r.enemy_hp);'||chr(10)||
   '   mistake_data:=jsonb_build_object(''book'',question->>''book'',''number'',(question->>''number'')::integer,'||chr(10)||
   '    ''prompt'',question->>''prompt'',''correctText'',question->>''correctText'');'),
  ('VALUES(actor,request_uuid,p_action,request_hash,run_uuid,output-''run''-''wallet'');',
   'VALUES(actor,request_uuid,p_action,request_hash,run_uuid,CASE WHEN mistake_data IS NULL THEN output-''run''-''wallet'''||chr(10)||
   '    ELSE jsonb_set(output-''run''-''wallet'',''{answer,mistake}'',mistake_data) END);'),
  (' RETURN output;'||chr(10)||'EXCEPTION WHEN SQLSTATE ''54000'' THEN',
   ' IF p_action=''answer'' AND r.status=''lost'' THEN'||chr(10)||
   '  output:=jsonb_set(output,''{run}'',target_private.challenge_dto(run_uuid,actor));'||chr(10)||
   ' END IF;'||chr(10)||
   ' RETURN output;'||chr(10)||'EXCEPTION WHEN SQLSTATE ''54000'' THEN')
 ) patches(old_text,new_text) LOOP
  IF (length(definition)-length(replace(definition,item.old_text,'')))/length(item.old_text)<>1 THEN
   RAISE EXCEPTION 'Challenge mistake snapshot marker changed: %',item.old_text; END IF;
  definition:=replace(definition,item.old_text,item.new_text);
 END LOOP;
 EXECUTE definition;
 FOR item IN SELECT * FROM (VALUES
  ('public.target_challenge_rpc(text,text,jsonb)','f420287f88c5e5f598c9e679f711b90c'),
  ('target_private.challenge_dto(uuid,uuid)','60bf3c79589f69523fda3939d0e381be'),
  ('target_private.challenge_storage_charge()','71d4ba2553f5ef56ca0ebc65063f42d9')
 ) expected(signature,digest) LOOP
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure(item.signature)) IS DISTINCT FROM item.digest THEN
   RAISE EXCEPTION 'Unexpected defeat-review definition: %',item.signature; END IF;
 END LOOP;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='target_private.wallet_finance_projection(timestamptz)'::regprocedure)
  IS DISTINCT FROM finance_before THEN
  RAISE EXCEPTION 'Defeat review changed shared financial projection'; END IF;
END; $patch$;
COMMIT;
