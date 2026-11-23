-- ================= SnapPages: payouts (withdraw) + Star reaction totals =================
-- Paste this CODE into Supabase -> SQL Editor and Run. Safe to re-run. (Run 16 and 17 first.)

-- 1. Star reaction total shown first in the reaction row of every post / reel
alter table posts  add column if not exists tip_total bigint default 0;
alter table videos add column if not exists tip_total bigint default 0;

-- keep the latest tip_stars (with Top Senders flag) and also count the reaction total
drop function if exists tip_stars(text, text, text, int, int);
create or replace function tip_stars(p_user text, p_type text, p_id text, p_amount int, p_fee int, p_anon boolean default false)
returns jsonb language plpgsql as $$
declare v_author text; v_cut bigint; bal bigint; v_total bigint;
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
    insert into star_txns(user_id, kind, amount, content_type, content_id, other_id, note) values (p_user, 'tip', -p_amount, p_type, p_id, v_author, case when p_anon then 'anon' else null end);
    insert into star_txns(user_id, kind, amount, content_type, content_id, other_id) values (v_author, 'tip_in', v_cut, p_type, p_id, p_user);
    if p_type = 'video' then
        update videos set stars_count = coalesce(stars_count,0)+p_amount, tip_total = coalesce(tip_total,0)+p_amount where id::text = p_id returning tip_total into v_total;
    else
        update posts set stars_count = coalesce(stars_count,0)+p_amount, tip_total = coalesce(tip_total,0)+p_amount where id::text = p_id returning tip_total into v_total;
    end if;
    return jsonb_build_object('ok', true, 'balance', bal, 'author', v_author, 'tip_total', v_total);
end $$;

-- back-fill totals from existing tips
update posts p set tip_total = s.t from (select content_id, sum(-amount) t from star_txns where kind = 'tip' and content_type = 'post' group by content_id) s where p.id::text = s.content_id;
update videos v set tip_total = s.t from (select content_id, sum(-amount) t from star_txns where kind = 'tip' and content_type = 'video' group by content_id) s where v.id::text = s.content_id;

-- 2. Payout (withdraw) requests: Stars are held immediately, refunded if rejected
create table if not exists star_payouts (
    id bigint generated always as identity primary key,
    user_id text not null,
    stars bigint not null,
    amount numeric,
    currency text,
    destination text,
    status text default 'pending',          -- pending | paid | rejected
    admin_note text,
    created_at timestamptz default now(),
    resolved_at timestamptz
);
create index if not exists idx_star_payouts_user on star_payouts(user_id, created_at desc);
create index if not exists idx_star_payouts_status on star_payouts(status, created_at);

create or replace function request_payout(p_user text, p_stars bigint, p_amount numeric, p_currency text, p_dest text)
returns jsonb language plpgsql as $$
declare bal bigint; pid bigint; pend int;
begin
    select count(*) into pend from star_payouts where user_id = p_user and status = 'pending';
    if pend >= 3 then return jsonb_build_object('ok', false, 'error', 'too_many'); end if;
    update users set stars_balance = coalesce(stars_balance,0) - p_stars
        where tg_id = p_user and coalesce(stars_balance,0) >= p_stars returning stars_balance into bal;
    if bal is null then return jsonb_build_object('ok', false, 'error', 'insufficient'); end if;
    insert into star_payouts(user_id, stars, amount, currency, destination) values (p_user, p_stars, p_amount, p_currency, p_dest) returning id into pid;
    insert into star_txns(user_id, kind, amount, note) values (p_user, 'payout', -p_stars, 'Withdrawal #' || pid);
    return jsonb_build_object('ok', true, 'id', pid, 'balance', bal);
end $$;

create or replace function resolve_payout(p_id bigint, p_action text, p_note text default null)
returns jsonb language plpgsql as $$
declare po star_payouts%rowtype; bal bigint;
begin
    if p_action not in ('paid', 'rejected') then return jsonb_build_object('ok', false, 'error', 'bad_action'); end if;
    update star_payouts set status = p_action, admin_note = p_note, resolved_at = now() where id = p_id and status = 'pending' returning * into po;
    if po.id is null then return jsonb_build_object('ok', false, 'error', 'not_pending'); end if;
    if p_action = 'rejected' then
        update users set stars_balance = coalesce(stars_balance,0) + po.stars where tg_id = po.user_id returning stars_balance into bal;
        insert into star_txns(user_id, kind, amount, note) values (po.user_id, 'payout_refund', po.stars, 'Withdrawal #' || po.id || ' refunded');
    end if;
    return jsonb_build_object('ok', true, 'user', po.user_id, 'stars', po.stars, 'status', p_action);
end $$;

notify pgrst, 'reload schema';
