-- ================= SnapPages: Story reactions & views =================
-- Paste into Supabase -> SQL Editor and Run. Safe to re-run.
create table if not exists story_reactions (
    story_id bigint not null,
    user_id text not null,
    emoji text not null,
    created_at timestamptz default now(),
    primary key (story_id, user_id)
);
create index if not exists idx_story_reactions_story on story_reactions(story_id);
create table if not exists story_views (
    story_id bigint not null,
    user_id text not null,
    created_at timestamptz default now(),
    primary key (story_id, user_id)
);
create index if not exists idx_story_views_story on story_views(story_id);
