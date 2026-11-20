-- ================= SnapPages Admin Panel — Supabase Migration =================
-- Run this once in the Supabase SQL editor before deploying the updated server.js / index.html.

-- 1. New columns on existing tables
alter table users add column if not exists is_verified boolean default false;
alter table users add column if not exists is_admin boolean default false;
alter table posts add column if not exists is_pinned boolean default false;

-- 2. Reports (feeds the Manage tab)
create table if not exists reports (
    id bigint generated always as identity primary key,
    post_id text not null,
    post_author_id text,
    post_type text,
    reporter_id text,
    reason text,
    created_at timestamptz default now()
);
create index if not exists idx_reports_post_id on reports(post_id);

-- 3. Banned users (their content is deleted, and they can't re-register)
create table if not exists banned_users (
    tg_id text primary key,
    banned_at timestamptz default now()
);

-- 4. Banned channels (blocked from being auto-synced or re-added)
create table if not exists banned_channels (
    channel_id text primary key,
    banned_at timestamptz default now()
);

-- 5. Simple key/value app settings (maintenance mode, etc.)
create table if not exists app_settings (
    key text primary key,
    value text
);
insert into app_settings (key, value) values ('maintenance_mode', 'false')
    on conflict (key) do nothing;

-- 6. Make yourself an admin so you can open the Admin Panel the first time.
-- Replace 123456789 with your own Telegram numeric ID, then run this line manually:
-- update users set is_admin = true where tg_id = '123456789';
