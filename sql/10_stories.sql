-- ================= SnapPages: Stories (24-hour status) =================
-- Paste this CODE into Supabase -> SQL Editor and Run. Safe to re-run.
create table if not exists stories (
    id bigint generated always as identity primary key,
    author_id text not null,
    author_name text,
    image_url text not null,
    caption text,
    created_at timestamptz default now()
);
create index if not exists idx_stories_created_at on stories(created_at);
create index if not exists idx_stories_author_id on stories(author_id);
