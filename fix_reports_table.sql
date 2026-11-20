-- ================= Fix: Report option not reaching the Admin Panel =================
-- Run once in the Supabase SQL editor. Safe to re-run.
-- Makes sure "reports" can store BOTH post ids (uuid) and video ids (number).

create table if not exists reports (
    id bigint generated always as identity primary key,
    post_id text not null,
    post_author_id text,
    post_type text,
    reporter_id text,
    reason text,
    created_at timestamptz default now()
);

alter table reports drop constraint if exists reports_post_id_fkey;
alter table reports alter column post_id type text using post_id::text;
alter table reports alter column post_author_id type text using post_author_id::text;
alter table reports alter column reporter_id type text using reporter_id::text;
alter table reports add column if not exists content_type text default 'post';
create index if not exists idx_reports_post_id on reports(post_id);
