-- 플랜두씨 다이어리 1 (T06) · pds-schema-v2
-- Supabase 대시보드 → SQL Editor → New query 에 전부 붙여 넣고 Run 합니다.
-- 여러 번 실행해도 안전하도록 if not exists / drop if exists 를 썼습니다.
-- 표 구조와 날짜 규칙 설명은 contracts/pds-schema-v2.json 에 있습니다.

create extension if not exists pgcrypto;

-- ───────── Plan: 그날 실제로 세운 계획 ─────────
create table if not exists public.pds_plans (
  id           uuid primary key default gen_random_uuid(),
  plan_date    date not null,                                   -- 계획한 날 (Asia/Seoul 기준 달력 날짜)
  title        text not null check (char_length(btrim(title)) between 1 and 200),
  metric       text check (metric is null or char_length(metric) <= 100),   -- 무엇으로 잴지 (예: 공부 시간)
  target_value numeric check (target_value is null or target_value >= 0),   -- 목표 수치
  unit         text check (unit is null or char_length(unit) <= 30),        -- 단위 (예: 분, 쪽, 회)
  created_at   timestamptz not null default now()
);
create index if not exists pds_plans_plan_date_idx on public.pds_plans (plan_date);

-- ───────── Do: 그 계획에 대해 실제로 한 일 ─────────
create table if not exists public.pds_dos (
  id           uuid primary key default gen_random_uuid(),
  plan_id      uuid not null references public.pds_plans(id) on delete cascade,
  done_date    date not null,                                   -- 실제로 한 날 (Asia/Seoul)
  actual_value numeric check (actual_value is null or actual_value >= 0),
  note         text check (note is null or char_length(note) <= 500),
  created_at   timestamptz not null default now(),
  constraint pds_dos_has_content
    check (actual_value is not null or (note is not null and char_length(btrim(note)) > 0))
);
create index if not exists pds_dos_plan_id_idx on public.pds_dos (plan_id);

-- ───────── See: 하루를 돌아보기 (하루에 한 개) ─────────
create table if not exists public.pds_sees (
  id          uuid primary key default gen_random_uuid(),
  see_date    date not null unique,                             -- 돌아본 날 (Asia/Seoul)
  went_well   text check (went_well   is null or char_length(went_well)   <= 2000),
  to_improve  text check (to_improve  is null or char_length(to_improve)  <= 2000),
  next_action text check (next_action is null or char_length(next_action) <= 2000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ───────── 날짜 규칙: Do는 계획한 날보다 앞설 수 없다 ─────────
create or replace function public.pds_check_do_date()
returns trigger language plpgsql as $$
declare
  p_date date;
begin
  select plan_date into p_date from public.pds_plans where id = new.plan_id;
  if p_date is null then
    raise exception 'plan % not found', new.plan_id;
  end if;
  if new.done_date < p_date then
    raise exception 'done_date(%) must not be earlier than plan_date(%)', new.done_date, p_date;
  end if;
  return new;
end $$;

drop trigger if exists pds_dos_date_rule on public.pds_dos;
create trigger pds_dos_date_rule
  before insert or update on public.pds_dos
  for each row execute function public.pds_check_do_date();

-- See 를 고치면 updated_at 을 서버 시각으로 갱신
create or replace function public.pds_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists pds_sees_touch on public.pds_sees;
create trigger pds_sees_touch
  before update on public.pds_sees
  for each row execute function public.pds_touch_updated_at();

-- ───────── 권한 ─────────
-- T06 은 로그인이 없는 공개 다이어리라서 anon(공개 키) 역할에 읽기·쓰기를 허용합니다.
-- 링크를 아는 사람은 누구나 보고 고칠 수 있으므로 남이 봐도 괜찮은 내용만 적습니다.
-- T07 에서 로그인을 붙이면서 이 정책을 "본인 행만" 정책으로 바꿉니다.
alter table public.pds_plans enable row level security;
alter table public.pds_dos   enable row level security;
alter table public.pds_sees  enable row level security;

grant select, insert, update, delete on public.pds_plans, public.pds_dos, public.pds_sees to anon;

drop policy if exists "t06_public_diary" on public.pds_plans;
drop policy if exists "t06_public_diary" on public.pds_dos;
drop policy if exists "t06_public_diary" on public.pds_sees;
create policy "t06_public_diary" on public.pds_plans for all to anon using (true) with check (true);
create policy "t06_public_diary" on public.pds_dos   for all to anon using (true) with check (true);
create policy "t06_public_diary" on public.pds_sees  for all to anon using (true) with check (true);
