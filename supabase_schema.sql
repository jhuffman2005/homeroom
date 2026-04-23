-- ─────────────────────────────────────────────────────────────
-- HomeRoom — Supabase Schema
-- Run this in your Supabase SQL editor (Database > SQL Editor)
-- ─────────────────────────────────────────────────────────────

-- profiles: one row per user, linked to auth.users
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  created_at timestamptz default now()
);

-- kids: students belonging to a user
create table if not exists kids (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  name text not null,
  grade text not null,
  learning_style text,
  emoji text default '📚',
  created_at timestamptz default now()
);

-- subjects: subjects for each kid (per semester)
create table if not exists subjects (
  id uuid primary key default gen_random_uuid(),
  kid_id uuid not null references kids(id) on delete cascade,
  name text not null,
  created_at timestamptz default now()
);

-- semesters: semester date ranges per user
create table if not exists semesters (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  label text default 'Current Semester',
  start_date date not null,
  end_date date not null,
  is_active boolean default true,
  created_at timestamptz default now()
);

-- curriculum_weeks: AI-parsed week-by-week plan per subject
create table if not exists curriculum_weeks (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references subjects(id) on delete cascade,
  week_number integer not null,
  topic text not null,
  description text,
  created_at timestamptz default now(),
  unique(subject_id, week_number)
);

-- generations: history of all AI-generated materials
create table if not exists generations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  kid_id uuid references kids(id) on delete set null,
  kid_name text,           -- denormalized for display after kid deletion
  subject_name text,
  tool_id text not null,   -- 'lesson' | 'worksheet' | 'quiz' | 'studyguide'
  tool_title text not null,
  tool_icon text,
  topic text not null,
  content text not null,
  created_at timestamptz default now()
);

-- ─── Row Level Security ───────────────────────────────────────
alter table profiles enable row level security;
alter table kids enable row level security;
alter table subjects enable row level security;
alter table semesters enable row level security;
alter table curriculum_weeks enable row level security;
alter table generations enable row level security;

-- profiles: users can only read/write their own row
create policy "profiles: own row" on profiles
  for all using (auth.uid() = id);

-- kids: users can only access their own kids
create policy "kids: own" on kids
  for all using (auth.uid() = user_id);

-- subjects: access through kid ownership
create policy "subjects: own kids" on subjects
  for all using (
    exists (select 1 from kids where kids.id = subjects.kid_id and kids.user_id = auth.uid())
  );

-- semesters: own rows
create policy "semesters: own" on semesters
  for all using (auth.uid() = user_id);

-- curriculum_weeks: access through subject → kid ownership
create policy "curriculum_weeks: own" on curriculum_weeks
  for all using (
    exists (
      select 1 from subjects
      join kids on kids.id = subjects.kid_id
      where subjects.id = curriculum_weeks.subject_id
      and kids.user_id = auth.uid()
    )
  );

-- generations: own rows
create policy "generations: own" on generations
  for all using (auth.uid() = user_id);

-- ─── Auto-create profile on signup ───────────────────────────
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, name)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)));
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ─────────────────────────────────────────────────────────────
-- Lesson plans, plan items, and kid schedule rules
-- ─────────────────────────────────────────────────────────────

-- lesson_plans: a weekly plan for a kid
create table if not exists lesson_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  kid_id uuid not null references kids(id) on delete cascade,
  week_start_date date not null,
  created_at timestamptz default now()
);

-- lesson_plan_items: individual tasks within a weekly plan
create table if not exists lesson_plan_items (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references lesson_plans(id) on delete cascade,
  day text not null,
  subject text,
  task_title text not null,
  content text,
  status text default 'todo',
  assignment_token uuid default gen_random_uuid(),
  assigned_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz default now()
);

create index if not exists lesson_plan_items_assignment_token_idx
  on lesson_plan_items(assignment_token);

-- kid_schedule_rules: recurring schedule rules per kid
create table if not exists kid_schedule_rules (
  id uuid primary key default gen_random_uuid(),
  kid_id uuid not null references kids(id) on delete cascade,
  subject text not null,
  days_of_week text[] not null default '{}',
  notes text,
  created_at timestamptz default now()
);

-- ─── RLS ─────────────────────────────────────────────────────
alter table lesson_plans enable row level security;
alter table lesson_plan_items enable row level security;
alter table kid_schedule_rules enable row level security;

-- lesson_plans: own rows
create policy "lesson_plans: own" on lesson_plans
  for all using (auth.uid() = user_id);

-- lesson_plan_items: access through plan → user ownership
create policy "lesson_plan_items: own via plan" on lesson_plan_items
  for all using (
    exists (
      select 1 from lesson_plans
      where lesson_plans.id = lesson_plan_items.plan_id
      and lesson_plans.user_id = auth.uid()
    )
  );

-- lesson_plan_items: anonymous token lookup
-- Security relies on assignment_token being an unguessable UUID.
-- Clients MUST always filter by assignment_token when querying as anon.
create policy "lesson_plan_items: anon token read" on lesson_plan_items
  for select to anon using (assignment_token is not null);

-- lesson_plan_items: anonymous "mark complete" via token
-- Allows the kid (no login) to flip status to 'complete' on their own assignment.
-- with check restricts what the row can be updated to.
create policy "lesson_plan_items: anon token complete" on lesson_plan_items
  for update to anon
  using (assignment_token is not null)
  with check (status in ('assigned', 'complete'));

-- kid_schedule_rules: access through kid ownership
create policy "kid_schedule_rules: own via kid" on kid_schedule_rules
  for all using (
    exists (
      select 1 from kids
      where kids.id = kid_schedule_rules.kid_id
      and kids.user_id = auth.uid()
    )
  );

-- ─────────────────────────────────────────────────────────────
-- Profile & curriculum source-of-truth fields
-- ─────────────────────────────────────────────────────────────

alter table kids add column if not exists avatar_url text;
alter table subjects add column if not exists book_title text;
alter table subjects add column if not exists book_link text;

-- ─── Storage bucket for kid avatars ──────────────────────────
insert into storage.buckets (id, name, public)
  values ('avatars', 'avatars', true)
  on conflict (id) do nothing;

-- Avatar files live at avatars/{user_id}/{kid_id}.{ext}
-- Owner can write to their own folder; anyone can read (bucket is public).
drop policy if exists "Avatar uploads by owner" on storage.objects;
create policy "Avatar uploads by owner" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Avatar updates by owner" on storage.objects;
create policy "Avatar updates by owner" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Avatar deletes by owner" on storage.objects;
create policy "Avatar deletes by owner" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Public read avatars" on storage.objects;
create policy "Public read avatars" on storage.objects
  for select to public
  using (bucket_id = 'avatars');
