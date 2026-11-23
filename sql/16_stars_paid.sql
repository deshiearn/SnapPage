-- ================= SnapPages: Stars wallet + paid (premium) posts & reels =================
-- Paste this CODE into Supabase -> SQL Editor and Run. Safe to re-run.

-- 1. Wallet balance on every user
alter table users add column if not exists stars_balance bigint default 0;
alter table users add column if not exists stars_earned  bigint default 0;

-- 2. Price / preview / counters on posts and videos (price 0 = free)
alter table posts  add column if not exists price int default 0;
alter table posts  add column if not exists preview_url text;          -- small blurred preview shown while locked
alter table posts  add column if not exists unlock_count int default 0;
alter table posts  add column if not exists stars_count bigint default 0;
alter table videos add column if not exists price int default 0;
alter table videos add column if not exists preview_url text;
alter table videos add column if not exists unlock_count int default 0;
alter table videos add column if not exists stars_count bigint default 0;
create index if not exists idx_posts_paid  on posts(created_at desc)  where price > 0;
create index if not exists idx_videos_paid on videos(created_at desc) where price > 0;

-- 3. The real media of paid items lives here (never returned by select('*') on posts/videos)
create table if not exists paid_assets (
    content_type text not null,            -- 'post' | 'video'
    content_id   text not null,
    image_urls   jsonb default '[]'::jsonb,
    file_id      text,
    primary key (content_type, content_id)
);

-- 4. Who unlocked what
create table if not exists unlocks (
    user_id text not null,
    content_type text not null,
    content_id text not null,
    price int not null,
    created_at timestamptz default now(),
    primary key (user_id, content_type, content_id)
);

-- 5. Wallet history (amount > 0 = received, < 0 = spent)
create table if not exists star_txns (
    id bigint generated always as identity primary key,
    user_id text not null,
    kind text not null,                    -- deposit | unlock | earn | tip | tip_in | admin | payout
    amount bigint not null,
    content_type text,
    content_id text,
    other_id text,
    note text,
    created_at timestamptz default now()
);
create index if not exists idx_star_txns_user on star_txns(user_id, created_at desc);

-- 6. Deposits made through xRocket
create table if not exists star_deposits (
    id bigint generated always as identity primary key,
    user_id text not null,
    stars bigint not null,
    amount numeric,
    currency text,
    ext_id text,                           -- xRocket invoice id
    pay_url text,
    status text default 'pending',         -- pending | paid | expired
    created_at timestamptz default now(),
    paid_at timestamptz
);
create index if not exists idx_star_deposits_user on star_deposits(user_id, created_at desc);
create index if not exists idx_star_deposits_pending on star_deposits(status) where status = 'pending';

-- 7. Atomic operations (no double spend, no double credit)
create or replace function stars_adjust(p_user text, p_amount bigint, p_kind text, p_note text default null)
returns jsonb language plpgsql as $$
declare bal bigint;
begin
    update users set stars_balance = coalesce(stars_balance,0) + p_amount
        where tg_id = p_user and coalesce(stars_balance,0) + p_amount >= 0
        returning stars_balance into bal;
    if bal is null then return jsonb_build_object('ok', false, 'error', 'insufficient'); end if;
    insert into star_txns(user_id, kind, amount, note) values (p_user, p_kind, p_amount, p_note);
    return jsonb_build_object('ok', true, 'balance', bal);
end $$;

create or replace function unlock_content(p_user text, p_type text, p_id text, p_fee int)
returns jsonb language plpgsql as $$
declare v_price int; v_author text; v_cut bigint; bal bigint;
begin
    if p_type = 'video' then
        select price, author_id into v_price, v_author from videos where id::text = p_id;
    else
        select price, author_id into v_price, v_author from posts where id::text = p_id;
    end if;
    if v_price is null or v_price <= 0 then return jsonb_build_object('ok', false, 'error', 'not_paid'); end if;
    if v_author = p_user or exists (select 1 from unlocks where user_id = p_user and content_type = p_type and content_id = p_id) then
        select stars_balance into bal from users where tg_id = p_user;
        return jsonb_build_object('ok', true, 'already', true, 'balance', coalesce(bal,0));
    end if;
    update users set stars_balance = coalesce(stars_balance,0) - v_price
        where tg_id = p_user and coalesce(stars_balance,0) >= v_price returning stars_balance into bal;
    if bal is null then return jsonb_build_object('ok', false, 'error', 'insufficient'); end if;
    v_cut := v_price - floor(v_price * p_fee / 100.0);
    update users set stars_balance = coalesce(stars_balance,0) + v_cut, stars_earned = coalesce(stars_earned,0) + v_cut where tg_id = v_author;
    insert into unlocks(user_id, content_type, content_id, price) values (p_user, p_type, p_id, v_price);
    insert into star_txns(user_id, kind, amount, content_type, content_id, other_id) values (p_user, 'unlock', -v_price, p_type, p_id, v_author);
    insert into star_txns(user_id, kind, amount, content_type, content_id, other_id) values (v_author, 'earn', v_cut, p_type, p_id, p_user);
    if p_type = 'video' then update videos set unlock_count = coalesce(unlock_count,0)+1, stars_count = coalesce(stars_count,0)+v_price where id::text = p_id;
    else update posts set unlock_count = coalesce(unlock_count,0)+1, stars_count = coalesce(stars_count,0)+v_price where id::text = p_id; end if;
    return jsonb_build_object('ok', true, 'balance', bal, 'author', v_author, 'price', v_price);
end $$;

create or replace function tip_stars(p_user text, p_type text, p_id text, p_amount int, p_fee int)
returns jsonb language plpgsql as $$
declare v_author text; v_cut bigint; bal bigint;
begin
    if p_amount < 1 or p_amount > 10000 then return jsonb_build_object('ok', false, 'error', 'bad_amount'); end if;
    if p_type = 'video' then select author_id into v_author from videos where id::text = p_id;
    else select author_id into v_author from posts where id::text = p_id; end if;
    if v_author is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
    if v_author = p_user then return jsonb_build_object('ok', false, 'error', 'self'); end if;
    update users set stars_balance = coalesce(stars_balance,0) - p_amount
        where tg_id = p_user and coalesce(stars_balance,0) >= p_amount returning stars_balance into bal;
    if bal is null then return jsonb_build_object('ok', false, 'error', 'insufficient'); end if;
    v_cut := p_amount - floor(p_amount * p_fee / 100.0);
    update users set stars_balance = coalesce(stars_balance,0) + v_cut, stars_earned = coalesce(stars_earned,0) + v_cut where tg_id = v_author;
    insert into star_txns(user_id, kind, amount, content_type, content_id, other_id) values (p_user, 'tip', -p_amount, p_type, p_id, v_author);
    insert into star_txns(user_id, kind, amount, content_type, content_id, other_id) values (v_author, 'tip_in', v_cut, p_type, p_id, p_user);
    if p_type = 'video' then update videos set stars_count = coalesce(stars_count,0)+p_amount where id::text = p_id;
    else update posts set stars_count = coalesce(stars_count,0)+p_amount where id::text = p_id; end if;
    return jsonb_build_object('ok', true, 'balance', bal, 'author', v_author);
end $$;

create or replace function credit_deposit(p_id bigint)
returns jsonb language plpgsql as $$
declare d star_deposits%rowtype; bal bigint;
begin
    update star_deposits set status = 'paid', paid_at = now() where id = p_id and status = 'pending' returning * into d;
    if d.id is null then return jsonb_build_object('ok', false, 'error', 'not_pending'); end if;
    update users set stars_balance = coalesce(stars_balance,0) + d.stars where tg_id = d.user_id returning stars_balance into bal;
    insert into star_txns(user_id, kind, amount, note) values (d.user_id, 'deposit', d.stars, 'xRocket #' || coalesce(d.ext_id,''));
    return jsonb_build_object('ok', true, 'balance', bal, 'user', d.user_id, 'stars', d.stars);
end $$;
