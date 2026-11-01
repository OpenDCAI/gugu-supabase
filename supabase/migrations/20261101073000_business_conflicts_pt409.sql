-- Business conflicts answer 409 instead of being retried forever.
--
-- Four stale-revision refusals raised SQLSTATE 40001 (serialization_failure). PostgREST treats 40001 as a
-- transient conflict and retries the whole request; a stale revision never resolves by retrying, so the
-- request looped server-side, logging dozens of errors a second and saturating the database CPU.
-- PT409 is PostgREST's pass-through code: it answers HTTP 409 with code PT409 once and does not retry.
--
-- The functions are rewritten from their current installed definitions, changing only the ERRCODE of those
-- refusals, so later edits to their bodies are kept and an installation that already carries the same
-- change (a hotfix) ends in the same state. CREATE OR REPLACE keeps owner, grants and settings.
DO $pt409$
DECLARE
  fn regprocedure;
  def text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'identity.assistant_panel_commit(text,uuid,text,text,bigint,text,jsonb,uuid,text,text,text)'::regprocedure,
    'identity.assistant_panel_admit(text,text,bigint)'::regprocedure,
    'identity.set_agent_session_archival(text,text,uuid,bigint,timestamp with time zone,jsonb)'::regprocedure
  ] LOOP
    def := pg_get_functiondef(fn);
    IF position('ERRCODE = ''40001''' IN def) > 0 THEN
      EXECUTE replace(def, 'ERRCODE = ''40001''', 'ERRCODE = ''PT409''');
    END IF;
    IF position('40001' IN pg_get_functiondef(fn)) > 0 OR position('PT409' IN pg_get_functiondef(fn)) = 0 THEN
      RAISE EXCEPTION '% still raises 40001 or never raises PT409', fn;
    END IF;
  END LOOP;
END
$pt409$;
