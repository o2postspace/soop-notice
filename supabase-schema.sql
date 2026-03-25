-- Supabase SQL Editor에서 실행하세요
-- Dashboard > SQL Editor > New Query

create table notices (
  id bigserial primary key,
  bj_id text not null,
  bj_name text not null,
  bj_tag text not null,
  title_no bigint not null unique,
  title_name text default '',
  content_html text default '',
  reg_date timestamptz not null,
  read_cnt integer default 0,
  is_pin boolean default false,
  updated_at timestamptz default now()
);

-- 빠른 조회를 위한 인덱스
create index idx_notices_reg_date on notices(reg_date desc);
create index idx_notices_bj_id on notices(bj_id);

-- RLS (Row Level Security) - 읽기는 누구나, 쓰기는 서비스 역할만
alter table notices enable row level security;

create policy "누구나 읽기 가능"
  on notices for select
  using (true);

create policy "서비스 역할만 쓰기 가능"
  on notices for insert
  with check (true);

create policy "서비스 역할만 수정 가능"
  on notices for update
  using (true);
