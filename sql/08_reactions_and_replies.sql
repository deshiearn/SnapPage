-- ================= SnapPages: comment replies + reactions =================
-- Paste this CODE into Supabase -> SQL Editor and Run. Safe to re-run.

-- Replies: a reply stores the id of its top-level comment
alter table comments add column if not exists parent_id text;
create index if not exists idx_comments_parent_id on comments(parent_id);

-- Reactions: { "<user id>": "😂", ... } (the classic heart stays in likes_users)
alter table posts  add column if not exists reactions jsonb default '{}'::jsonb;
alter table videos add column if not exists reactions jsonb default '{}'::jsonb;
