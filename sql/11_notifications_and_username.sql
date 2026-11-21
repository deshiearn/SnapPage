-- ================= SnapPages: in-app notifications + editable @username =================
-- Paste this CODE into Supabase -> SQL Editor and Run. Safe to re-run.

-- 1. Editable username (separate from the Telegram username so "Open in Telegram" keeps working)
alter table users add column if not exists app_username text;
create unique index if not exists uq_users_app_username on users (lower(app_username)) where app_username is not null;

-- 2. In-app notifications (like, reaction, comment, reply, mention, share, views, follow, referral)
create table if not exists notifications (
    id bigint generated always as identity primary key,
    user_id text not null,            -- who receives it
    type text not null,
    actor_id text,                    -- who did it (null for milestones)
    actor_name text,
    actor_photo text,
    target_type text,                 -- 'post' | 'video' | 'profile'
    target_id text,
    comment_id text,
    message text,
    is_read boolean default false,
    created_at timestamptz default now()
);
create index if not exists idx_notifications_user on notifications(user_id, created_at desc);
create index if not exists idx_notifications_unread on notifications(user_id) where is_read = false;
