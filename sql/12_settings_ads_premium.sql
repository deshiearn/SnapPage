-- ================= SnapPages: notification switch, ads =================
-- Paste this CODE into Supabase -> SQL Editor and Run. Safe to re-run.

-- 1. Per-user "Notifications On/Off" (Off = no Telegram bot messages)
alter table users add column if not exists notify_enabled boolean default true;

-- 2. Ads created from the Admin panel
create table if not exists ads (
    id bigint generated always as identity primary key,
    title text not null,
    body text,
    image_url text,
    link_url text,
    button_text text default 'Learn more',
    placement text default 'feed',        -- 'feed' (between posts) | 'shorts'
    active boolean default true,
    impressions bigint default 0,
    clicks bigint default 0,
    created_at timestamptz default now()
);
create index if not exists idx_ads_active on ads(active, created_at desc);

-- 3. Click / impression counters for ads
create or replace function bump_ad(ad_id bigint, col text) returns void language plpgsql as $$
begin
    if col = 'clicks' then
        update ads set clicks = coalesce(clicks, 0) + 1 where id = ad_id;
    else
        update ads set impressions = coalesce(impressions, 0) + 1 where id = ad_id;
    end if;
end $$;
