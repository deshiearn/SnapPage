-- ================= SnapPages: Follow system + free-tier performance indexes =================
-- Paste this CODE into Supabase -> SQL Editor and Run. Safe to re-run.

-- 1. Follow system (users and channels can both be followed). Uses its own table name so it never clashes with an older "follows" table.
create table if not exists snap_follows (
    follower_id text not null,
    followee_id text not null,
    followee_type text,                       -- 'user' | 'channel'
    created_at timestamptz default now(),
    primary key (follower_id, followee_id)
);
create index if not exists idx_snap_follows_followee on snap_follows(followee_id);

-- 2. Indexes: keep every feed query fast so the free database stays well inside its limits
create index if not exists idx_posts_created_at on posts(created_at desc);
create index if not exists idx_posts_author_id  on posts(author_id);
create index if not exists idx_comments_post_id on comments(post_id);
create index if not exists idx_users_referred_by on users(referred_by);
