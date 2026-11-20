-- ================= Fix: Report option not reaching the Admin Panel =================
-- Run once in the Supabase SQL editor (paste the code, not the file name). Safe to re-run.
-- Makes sure "reports" has every column the app needs, and can store BOTH post ids (uuid)
-- and video ids (number).

create table if not exists reports (
    id bigint generated always as identity primary key,
    created_at timestamptz default now()
);

-- Add anything missing first (older tables may lack some columns)
alter table reports add column if not exists post_id text;
alter table reports add column if not exists post_author_id text;
alter table reports add column if not exists post_type text;
alter table reports add column if not exists reporter_id text;
alter table reports add column if not exists reason text;
alter table reports add column if not exists content_type text default 'post';
alter table reports add column if not exists created_at timestamptz default now();

-- Drop old foreign keys / NOT NULL and widen the id columns to text
alter table reports drop constraint if exists reports_post_id_fkey;
alter table reports alter column post_id drop not null;
alter table reports alter column post_id type text using post_id::text;
alter table reports alter column post_author_id type text using post_author_id::text;
alter table reports alter column reporter_id type text using reporter_id::text;

create index if not exists idx_reports_post_id on reports(post_id);
