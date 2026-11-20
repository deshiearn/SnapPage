-- ================= SnapPages: daily streak =================
-- Paste this CODE into Supabase -> SQL Editor and Run. Safe to re-run.
alter table users add column if not exists streak_count integer default 0;
alter table users add column if not exists best_streak integer default 0;
alter table users add column if not exists last_active_date text;
