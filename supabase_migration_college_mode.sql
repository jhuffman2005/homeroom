-- ─────────────────────────────────────────────────────────────
-- HomeRoom — College Mode migration
-- Run this ONCE in your Supabase project: SQL Editor → New query → paste → Run.
-- Safe to re-run (all statements are idempotent).
-- Parent/homeschool accounts are unaffected.
-- ─────────────────────────────────────────────────────────────

alter table profiles add column if not exists user_type text default 'parent';
update profiles set user_type = 'parent' where user_type is null;

alter table subjects add column if not exists course_code text;
alter table subjects add column if not exists professor text;
alter table subjects add column if not exists meeting_days text[];
alter table subjects add column if not exists syllabus_url text;
alter table subjects add column if not exists syllabus_text text;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, name, user_type)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data->>'user_type', 'parent')
  );
  return new;
end;
$$;
