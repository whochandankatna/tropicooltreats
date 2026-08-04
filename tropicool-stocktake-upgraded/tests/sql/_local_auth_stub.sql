-- TEST-ONLY harness, never applied to Supabase. Real Supabase projects
-- already provide auth.jwt()/auth.uid() and the anon/authenticated roles;
-- this stub exists purely so RLS policies can be exercised against a plain
-- local Postgres instance for pre-review verification.
create schema if not exists auth;
create or replace function auth.jwt() returns jsonb
language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb
$$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon;
  end if;
end $$;
grant usage on schema public to authenticated, anon;
grant usage on schema auth to authenticated, anon;
grant execute on function auth.jwt() to authenticated, anon;
