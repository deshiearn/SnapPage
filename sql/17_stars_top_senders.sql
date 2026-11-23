-- ================= SnapPages: "Show me in Top Senders" for Star reactions =================
-- Paste this CODE into Supabase -> SQL Editor and Run. Safe to re-run. (Run sql/16_stars_paid.sql first.)

drop function if exists tip_stars(text, text, text, int, int);

create or replace function tip_stars(p_user text, p_type text, p_id text, p_amount int, p_fee int, p_anon boolean default false)
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
    insert into star_txns(user_id, kind, amount, content_type, content_id, other_id, note) values (p_user, 'tip', -p_amount, p_type, p_id, v_author, case when p_anon then 'anon' else null end);
    insert into star_txns(user_id, kind, amount, content_type, content_id, other_id) values (v_author, 'tip_in', v_cut, p_type, p_id, p_user);
    if p_type = 'video' then update videos set stars_count = coalesce(stars_count,0)+p_amount where id::text = p_id;
    else update posts set stars_count = coalesce(stars_count,0)+p_amount where id::text = p_id; end if;
    return jsonb_build_object('ok', true, 'balance', bal, 'author', v_author);
end $$;

create index if not exists idx_star_txns_content on star_txns(content_type, content_id) where kind = 'tip';
notify pgrst, 'reload schema';
