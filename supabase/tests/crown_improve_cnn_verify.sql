-- Read-only production postflight. No fixture quizzes, identities or rewards.
BEGIN READ ONLY;
SET LOCAL statement_timeout='15s';
DO $verify$
DECLARE expected record; role_name text; relation_name text; signature text;
BEGIN
 FOR expected IN SELECT * FROM (VALUES
  ('public.target_rpc(text,text,jsonb)','b23ee976ec11ad3d3622d0011b1ec810'),
  ('target_private.mastery_snapshot(uuid,text)','eb053ab76923486be42e9f561572e81a'),
  ('target_private.record_section_mastery_achievement()','8f40fd8a0fe4033103824fff50682241'),
  ('public.target_badge_rpc(text,text,jsonb)','27dbd2c6e70d4ec22ef6194a50c51e23'),
  ('target_private.record_word_mastery()','80f9a2e4e1b336f3a896c29ccfe8cb2f'),
  ('target_private.wallet_finance_projection(timestamptz)','bd93399757a066fdfb8f35e7e29af2dc')
 ) AS pins(signature,hash)
 LOOP
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=expected.signature::regprocedure) IS DISTINCT FROM expected.hash THEN
   RAISE EXCEPTION 'Study material postflight function mismatch: %',expected.signature;
  END IF;
 END LOOP;
 FOR expected IN SELECT * FROM (VALUES
  ('target1900',1900,19),('target1000',1000,10),('kobun400',400,4),
  ('crown',32,2),('improve',42,4),('cnn',24,1)
 ) AS books(book,total,sections)
 LOOP
  IF target_private.study_book_size(expected.book)<>expected.total
    OR (SELECT count(*) FROM target_private.study_sections(expected.book))<>expected.sections
    OR (SELECT count(*) FROM target_private.study_sections(expected.book) s
        CROSS JOIN LATERAL generate_series(s.first_number,s.last_number)n)<>expected.total
    OR (SELECT count(DISTINCT n) FROM target_private.study_sections(expected.book) s
        CROSS JOIN LATERAL generate_series(s.first_number,s.last_number)n WHERE n BETWEEN 1 AND expected.total)<>expected.total THEN
   RAISE EXCEPTION 'Study material postflight coverage mismatch: %',expected.book;
  END IF;
 END LOOP;
 IF (SELECT jsonb_agg(jsonb_build_array(book,section,first_number,last_number) ORDER BY book,section)
     FROM (VALUES('crown'),('improve'),('cnn'))b(book)
     CROSS JOIN LATERAL target_private.study_sections(book)) IS DISTINCT FROM
    '[["cnn",1,1,24],["crown",6,1,17],["crown",7,18,32],["improve",8,1,10],["improve",9,11,20],["improve",10,21,30],["improve",11,31,42]]'::jsonb THEN
  RAISE EXCEPTION 'Study material postflight custom sections mismatch';
 END IF;
 IF target_private.study_book_size('unknown')<>0 OR EXISTS(SELECT 1 FROM target_private.study_sections('unknown')) THEN
  RAISE EXCEPTION 'Unknown study material is accepted';
 END IF;
 FOREACH signature IN ARRAY ARRAY['target_private.study_book_size(text)','target_private.study_sections(text)'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=signature::regprocedure AND NOT prosecdef
       AND provolatile='i' AND proisstrict AND proconfig=ARRAY['search_path=pg_catalog']) THEN
   RAISE EXCEPTION 'Study material helper security mismatch: %',signature;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a
       WHERE p.oid=signature::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE') THEN
   RAISE EXCEPTION 'Study material helper is executable by PUBLIC: %',signature;
  END IF;
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
   IF has_function_privilege(role_name,signature,'EXECUTE') THEN
    RAISE EXCEPTION 'Study material helper is exposed to %: %',role_name,signature;
   END IF;
  END LOOP;
 END LOOP;
 FOR expected IN SELECT * FROM (VALUES
  ('target_private.quizzes','quizzes_book_check'),('target_private.quizzes','quizzes_check4'),
  ('target_private.word_mastery','word_mastery_book_check'),('target_private.word_mastery','word_mastery_check'),
  ('target_private.section_mastery_achievements','section_mastery_achievements_book_check'),
  ('target_private.section_mastery_achievements','section_mastery_achievements_check')
 ) AS checks(relation_name,constraint_name)
 LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=expected.relation_name::regclass
       AND conname=expected.constraint_name AND contype='c' AND convalidated) THEN
   RAISE EXCEPTION 'Study material validated constraint missing: %.%',expected.relation_name,expected.constraint_name;
  END IF;
 END LOOP;
 FOREACH relation_name IN ARRAY ARRAY['target_private.quizzes','target_private.word_mastery','target_private.section_mastery_achievements'] LOOP
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid=relation_name::regclass) THEN
   RAISE EXCEPTION 'Study material relation RLS disabled: %',relation_name;
  END IF;
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
   IF has_table_privilege(role_name,relation_name,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
    RAISE EXCEPTION 'Study material relation exposed to %: %',role_name,relation_name;
   END IF;
  END LOOP;
 END LOOP;
END $verify$;
SELECT 'custom_study_materials_verified' AS verification,
 jsonb_build_object('crown',32,'improve',42,'cnn',24) AS new_book_sizes,
 33 AS legacy_badge_sections,37 AS legacy_badge_ids;
ROLLBACK;
