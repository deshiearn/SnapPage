-- ================= SnapPages: Telegram profile auto-sync + admin System tab =================
-- Paste this CODE into Supabase -> SQL Editor and Run. Safe to re-run.

-- 1. Auto-sync name / photo from Telegram (hand-edited values are never overwritten)
alter table users add column if not exists tg_synced_at timestamptz;
alter table users add column if not exists name_edited boolean default false;
alter table users add column if not exists photo_edited boolean default false;

-- 2. Real database size for Admin -> System
create or replace function db_stats() returns json language sql security definer as $$
    select json_build_object(
        'db_bytes', pg_database_size(current_database()),
        'tables', (select coalesce(json_object_agg(relname, pg_total_relation_size(c.oid)), '{}'::json)
                   from pg_class c join pg_namespace n on n.oid = c.relnamespace
                   where n.nspname = 'public' and c.relkind = 'r')
    );
$$;

-- 3. Faster feed queries
create index if not exists idx_posts_created on posts(created_at desc);
create index if not exists idx_videos_created on videos(created_at desc);
create index if not exists idx_posts_author on posts(author_id, created_at desc);
