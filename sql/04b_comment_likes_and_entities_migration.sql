-- ================= Feature additions: comment likes + rich text formatting =================
-- Run this once in the Supabase SQL editor.

-- 1. Comment likes (previously not supported — comments.likes_count didn't exist yet)
alter table comments add column if not exists likes_count integer default 0;
alter table comments add column if not exists likes_users text[] default '{}';

-- 2. Preserve Telegram's original formatting (bold, italic, links, text-links) from
-- channel posts/captions, so the app can render them exactly as they appear in Telegram.
alter table posts add column if not exists entities jsonb;
alter table videos add column if not exists entities jsonb;
