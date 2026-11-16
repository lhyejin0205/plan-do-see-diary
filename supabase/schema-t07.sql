-- 플랜두씨 다이어리 2 (T07) · pds-schema-v3
-- [개발 · DB구축 + 인증] 로그인한 사람마다 자기 자료만 읽고 쓰게 만드는 표와 정책
--
-- Supabase 대시보드 → SQL Editor → New query 에 전부 붙여 넣고 Run 합니다.
-- 여러 번 실행해도 안전하도록 if not exists / drop if exists 를 썼습니다.
--
-- T06 표(pds_plans 등)는 건드리지 않습니다. T06 공개 다이어리는 그대로 두고,
-- T07 은 pds7_ 로 시작하는 새 표를 씁니다. 모든 행에 owner_id(=auth.uid())가 붙고,
-- 행 수준 보안(RLS)이 "owner_id = 지금 로그인한 사람" 인 행만 허용합니다.
-- 로그인하지 않은 요청(anon)은 어떤 행도 읽거나 쓸 수 없습니다.

create extension if not exists pgcrypto;

-- ───────── 공통 함수 ─────────
create or replace function public.pds7_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ───────── Plan ─────────
create table if not exists public.pds7_plans (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  plan_date    date not null,
  title        text not null check (char_length(btrim(title)) between 1 and 200),
  metric       text check (metric is null or char_length(metric) <= 100),
  target_value numeric check (target_value is null or target_value >= 0),
  unit         text check (unit is null or char_length(unit) <= 30),
  created_at   timestamptz not null default now()
);
create index if not exists pds7_plans_owner_date_idx on public.pds7_plans (owner_id, plan_date);

-- ───────── Do ─────────
create table if not exists public.pds7_dos (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  plan_id      uuid not null references public.pds7_plans(id) on delete cascade,
  done_date    date not null,
  actual_value numeric check (actual_value is null or actual_value >= 0),
  note         text check (note is null or char_length(note) <= 500),
  created_at   timestamptz not null default now(),
  constraint pds7_dos_has_content
    check (actual_value is not null or (note is not null and char_length(btrim(note)) > 0))
);
create index if not exists pds7_dos_owner_plan_idx on public.pds7_dos (owner_id, plan_id);

-- Do 는 내 계획에만 달 수 있고, 계획한 날보다 앞설 수 없다
create or replace function public.pds7_check_do()
returns trigger language plpgsql as $$
declare
  p_owner uuid;
  p_date  date;
begin
  select owner_id, plan_date into p_owner, p_date from public.pds7_plans where id = new.plan_id;
  if p_owner is null then
    raise exception 'plan % not found', new.plan_id;
  end if;
  if p_owner <> new.owner_id then
    raise exception 'plan belongs to another owner';
  end if;
  if new.done_date < p_date then
    raise exception 'done_date(%) must not be earlier than plan_date(%)', new.done_date, p_date;
  end if;
  return new;
end $$;

drop trigger if exists pds7_dos_rule on public.pds7_dos;
create trigger pds7_dos_rule
  before insert or update on public.pds7_dos
  for each row execute function public.pds7_check_do();

-- ───────── See (사람마다 하루 하나) ─────────
create table if not exists public.pds7_sees (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  see_date    date not null,
  went_well   text check (went_well   is null or char_length(went_well)   <= 2000),
  to_improve  text check (to_improve  is null or char_length(to_improve)  <= 2000),
  next_action text check (next_action is null or char_length(next_action) <= 2000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint pds7_sees_one_per_day unique (owner_id, see_date)
);
drop trigger if exists pds7_sees_touch on public.pds7_sees;
create trigger pds7_sees_touch before update on public.pds7_sees
  for each row execute function public.pds7_touch_updated_at();

-- ───────── Mood (사람마다 하루 하나) ─────────
create table if not exists public.pds7_moods (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  mood_date  date not null,
  mood       text not null check (mood in ('great', 'calm', 'okay', 'tired', 'sad')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pds7_moods_one_per_day unique (owner_id, mood_date)
);
drop trigger if exists pds7_moods_touch on public.pds7_moods;
create trigger pds7_moods_touch before update on public.pds7_moods
  for each row execute function public.pds7_touch_updated_at();

-- ───────── Book ─────────
create table if not exists public.pds7_books (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title        text not null check (char_length(btrim(title)) between 1 and 200),
  author       text check (author is null or char_length(author) <= 100),
  total_pages  integer not null check (total_pages > 0),
  current_page integer not null default 0 check (current_page >= 0),
  reflection   text check (reflection is null or char_length(reflection) <= 2000),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint pds7_books_page_range check (current_page <= total_pages)
);
drop trigger if exists pds7_books_touch on public.pds7_books;
create trigger pds7_books_touch before update on public.pds7_books
  for each row execute function public.pds7_touch_updated_at();

-- ───────── 관찰 규칙 (T07 5일 관찰: 질문·지표·단위·계산 규칙과 그 변경 이력) ─────────
-- 규칙을 바꾸면 기존 행을 고치지 않고 새 버전을 추가한다. 바꾸기 전과 후가 그대로 남는다.
create table if not exists public.pds7_rules (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  version        integer not null check (version >= 1),
  effective_from date not null,                                  -- 이 규칙을 적용하기 시작한 날 (Asia/Seoul)
  question       text not null check (char_length(btrim(question)) between 1 and 300),
  metric         text not null check (char_length(btrim(metric)) between 1 and 100),
  unit           text not null check (char_length(btrim(unit)) between 1 and 30),
  calc_rule      text not null check (char_length(btrim(calc_rule)) between 1 and 500),
  change_reason  text check (change_reason is null or char_length(change_reason) <= 1000),
  learned        text check (learned is null or char_length(learned) <= 2000),
  created_at     timestamptz not null default now(),
  constraint pds7_rules_version_unique unique (owner_id, version)
);

-- ───────── 권한: 로그인한 본인 행만 ─────────
do $$
declare
  t text;
begin
  foreach t in array array['pds7_plans', 'pds7_dos', 'pds7_sees', 'pds7_moods', 'pds7_books', 'pds7_rules'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('drop policy if exists "t07_owner_only" on public.%I', t);
    execute format(
      'create policy "t07_owner_only" on public.%I for all to authenticated '
      'using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()))', t);
  end loop;
end $$;

-- 관찰 규칙은 기록이므로 고치거나 지우지 않는다(새 버전만 추가)
revoke update, delete on public.pds7_rules from authenticated;

-- API가 새 표를 바로 알아보도록 표 목록을 새로 고침
notify pgrst, 'reload schema';
