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
