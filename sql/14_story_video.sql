-- ================= SnapPages: video stories =================
-- Paste this CODE into Supabase -> SQL Editor and Run. Safe to re-run.
alter table stories add column if not exists video_url text;
alter table stories add column if not exists media_type text default 'image';
