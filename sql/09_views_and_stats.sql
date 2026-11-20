-- ================= SnapPages: view counts =================
-- Paste this CODE into Supabase -> SQL Editor and Run. Safe to re-run.
alter table posts  add column if not exists views integer default 0;
alter table videos add column if not exists views integer default 0;

-- Increments views for many items in a single query (keeps the free database fast)
create or replace function bump_views(tbl text, ids text[]) returns void
language plpgsql as $$
begin
    if tbl = 'posts' then
        update posts set views = coalesce(views, 0) + 1 where id::text = any(ids);
    elsif tbl = 'videos' then
        update videos set views = coalesce(views, 0) + 1 where id::text = any(ids);
    end if;
end;
$$;
