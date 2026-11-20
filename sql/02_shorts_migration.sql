-- ================= SnapPages Shorts (Video) — Supabase Migration =================
-- Run this AFTER admin_panel_migration.sql, once, in the Supabase SQL editor.

-- 1. Videos table — only Telegram file_id is stored, never raw video bytes.
create table if not exists videos (
    id bigint generated always as identity primary key,
    author_id text not null,
    author_name text,
    type text not null,               -- 'user' | 'channel'
    caption text,
    file_id text not null,            -- Telegram file_id used to stream the video
    storage_chat_id text,             -- where the video message actually lives
    storage_message_id bigint,        -- message id of that video, for cleanup
    owned_storage boolean default false, -- true only for our own storage-channel uploads
    likes_count integer default 0,
    likes_users text[] default '{}',
    created_at timestamptz default now()
);
create index if not exists idx_videos_created_at on videos(created_at);
create index if not exists idx_videos_author_id on videos(author_id);

-- 2. Comments now serve both posts and videos — tag each row with its content type.
alter table comments add column if not exists content_type text default 'post';

-- 3. Reports now also cover videos — tag each row with its content type.
alter table reports add column if not exists content_type text default 'post';

-- ================= Required Environment Variable =================
-- STORAGE_CHANNEL_ID — a private Telegram channel's numeric ID (e.g. -1001234567890).
-- The bot MUST be an admin of this channel. It's used purely as storage for
-- user-uploaded Shorts videos (channel-posted Shorts are auto-synced directly
-- from their own channel and don't need this).
