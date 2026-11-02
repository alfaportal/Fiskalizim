-- ENABLE_RLS.sql
-- Project: FISKALIZIM (FISKALIZIME)
-- Supabase: https://oqquiuisreztzcyehpiq.supabase.co (ref oqquiuisreztzcyehpiq)
-- Safe to run twice. Do not run from CI automatically.
-- Node server uses service_role (bypasses RLS). This closes PostgREST for anon + authenticated.

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.relname AS tablename
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relname NOT LIKE 'pg_%'
    ORDER BY c.relname
  LOOP
    EXECUTE format('ALTER TABLE IF EXISTS public.%I ENABLE ROW LEVEL SECURITY', r.tablename);
  END LOOP;
END $$;

ALTER TABLE IF EXISTS public.clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.licenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.terminalet_e_licences ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.users ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
