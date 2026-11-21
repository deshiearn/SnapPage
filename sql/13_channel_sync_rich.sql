-- ================= SnapPages: channel sync (deletions/edits) + rich posts (tables, slideshows) =================
-- Paste this CODE into Supabase -> SQL Editor and Run. Safe to re-run.
alter table posts add column if not exists src_msg_id text;     -- id of the original message in the channel
alter table posts add column if not exists rich jsonb;          -- Telegram rich_message blocks (tables, slideshows, lists...)
create index if not exists idx_posts_src on posts(author_id, src_msg_id);
