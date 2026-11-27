// ================= SnapPages Stars: wallet, paid (premium) content, xRocket deposits =================
// Registered from server.js:  require('./stars').register({ app, supabase, ... })
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const viewerCtx = new AsyncLocalStorage();
const DEFAULTS = {
    stars_enabled: 'true', xrocket_key: '', xrocket_base: 'https://pay.api.xrocket.exchange', xrocket_style: 'auto',
    xrocket_currency: 'USDT', stars_per_unit: '50', stars_fee_pct: '10', stars_min_price: '1', stars_max_price: '5000',
    stars_packs: '50,100,250,500,1000,2500', stars_min_deposit: '10',
    stars_topup_on: 'true', stars_payout_on: 'true', stars_payout_auto: 'true', payout_per_unit: '100', payout_min: '500',
    maintenance_mode: 'false', maintenance_msg: 'We are making SnapPages better. Please come back in a little while.'
};
const SETTING_KEYS = Object.keys(DEFAULTS);

function register(ctx) {
    const { app, supabase, validateTGData, isRealTgId, requireAdminUser, requireAdminPassword, bot, getUserMetaBatch } = ctx;
    const STREAM_SECRET = 'SnapStream' + (process.env.BOT_TOKEN || '');

    // ---------- settings (cached 30 s) ----------
    let setCache = { ts: 0, v: { ...DEFAULTS } };
    async function getSettings(force) {
        if (!force && Date.now() - setCache.ts < 6000) return setCache.v;
        try {
            const { data } = await supabase.from('app_settings').select('key, value').in('key', SETTING_KEYS);
            const v = { ...DEFAULTS };
            (data || []).forEach(r => { if (r.value !== null && r.value !== undefined && r.value !== '') v[r.key] = String(r.value); });
            setCache = { ts: Date.now(), v };
        } catch (e) { /* keep old */ }
        return setCache.v;
    }
    const num = (x, d) => { const n = parseFloat(x); return isFinite(n) ? n : d; };
    const publicConfig = (s) => ({
        enabled: s.stars_enabled !== 'false', packs: s.stars_packs.split(',').map(x => parseInt(x)).filter(x => x > 0).slice(0, 8),
        per_unit: num(s.stars_per_unit, 50), currency: s.xrocket_currency, fee: num(s.stars_fee_pct, 10),
        min_price: parseInt(s.stars_min_price) || 1, max_price: parseInt(s.stars_max_price) || 5000,
        min_deposit: parseInt(s.stars_min_deposit) || 10, deposits_ready: !!s.xrocket_key,
        topup_on: s.stars_topup_on !== 'false', payout_on: s.stars_payout_on !== 'false',
        payout_per_unit: num(s.payout_per_unit, 100), payout_min: parseInt(s.payout_min) || 500
    });

    // ---------- viewer context ----------
    app.use('/api', (req, res, next) => viewerCtx.run({ initData: req.body && req.body.initData }, next));
    // ---------- maintenance mode (whole app). Admins keep working; /api/admin/*, /api/status and webhooks stay open ----------
    const adminIds = new Map();   // id -> {v, exp}
    async function isAdminId(id) {
        if (!id) return false;
        const hit = adminIds.get(id); if (hit && hit.exp > Date.now()) return hit.v;
        const { data } = await supabase.from('users').select('is_admin').eq('tg_id', id).maybeSingle();
        const v = !!(data && data.is_admin); adminIds.set(id, { v, exp: Date.now() + 60000 }); return v;
    }
    app.use('/api', async (req, res, next) => {
        try {
            if (req.path.startsWith('/admin') || req.path === '/status' || req.path === '/appStatus' || req.path === '/stars/webhook') return next();
            const s = await getSettings();
            if (s.maintenance_mode !== 'true') return next();
            if (await isAdminId(viewerId())) return next();
            res.set('X-Maintenance', '1').status(503).json({ maintenance: true, error: 'Maintenance', message: s.maintenance_msg });
        } catch (e) { next(); }
    });
    app.get('/api/status', async (req, res) => { const s = await getSettings(); res.set('Cache-Control', 'no-store').json({ maintenance: s.maintenance_mode === 'true', message: s.maintenance_msg }); });
    app.post('/api/status', async (req, res) => { const s = await getSettings(); res.set('Cache-Control', 'no-store').json({ maintenance: s.maintenance_mode === 'true', message: s.maintenance_msg, admin: await isAdminId(viewerId()) }); });

    const viewerId = () => {
        const c = viewerCtx.getStore(); if (!c || !c.initData) return null;
        if (c.id === undefined) { const u = validateTGData(c.initData); c.id = u ? String(u.id) : null; }
        return c.id;
    };
    const signStream = (vid, uid) => { const exp = Math.floor(Date.now() / 1000) + 6 * 3600; return `${uid}.${exp}.${crypto.createHmac('sha256', STREAM_SECRET).update(`${vid}.${uid}.${exp}`).digest('hex').slice(0, 24)}`; };
    function checkStream(vid, tok) {
        const [uid, exp, sig] = String(tok || '').split('.');
        if (!uid || !exp || !sig || Number(exp) < Date.now() / 1000) return false;
        const ok = crypto.createHmac('sha256', STREAM_SECRET).update(`${vid}.${uid}.${exp}`).digest('hex').slice(0, 24);
        return ok.length === sig.length && crypto.timingSafeEqual(Buffer.from(ok), Buffer.from(sig));
    }

    // ---------- paywall: called on every list of posts/videos before it leaves the server ----------
    async function paywall(items, kind) {
        const paid = items.filter(i => i.price > 0);
        if (!paid.length) return items;
        const me = viewerId();
        const ids = paid.map(i => String(i.id));
        let open = new Set();
        if (me) {
            const { data } = await supabase.from('unlocks').select('content_id').eq('user_id', me).eq('content_type', kind).in('content_id', ids);
            (data || []).forEach(r => open.add(r.content_id));
            paid.forEach(i => { if (String(i.author_id) === me) open.add(String(i.id)); });
        }
        let assets = {};
        if (open.size) {
            const { data } = await supabase.from('paid_assets').select('content_id, image_urls').eq('content_type', kind).in('content_id', [...open]);
            (data || []).forEach(r => { assets[r.content_id] = r; });
        }
        return items.map(i => {
            if (!(i.price > 0)) return i;
            const id = String(i.id), unlocked = open.has(id);
            const out = { ...i, locked: !unlocked, unlocked };
            if (kind === 'video') { out.file_id = null; out.stream_url = unlocked && me ? `/api/videoStream/${id}?t=${signStream(id, me)}` : null; }
            else out.image_urls = unlocked ? ((assets[id] && assets[id].image_urls) || []) : [];
            if (kind === 'post' && i.type === 'channel' && i.src_msg_id) {   // paid post mirrored from a Telegram channel: unlock happens in Telegram
                out.locked = true; out.unlocked = false; out.image_urls = []; out.tg_paid = true;
                out.tg_link = `https://t.me/c/${String(i.author_id).replace(/^-100/, '')}/${i.src_msg_id}`;
            }
            if (!unlocked && kind === 'post') out.text = i.text ? String(i.text).slice(0, 60) : i.text;   // only a teaser of the caption
            return out;
        });
    }
    // Used by /api/videoStream: paid videos need a signed token
    const vmeta = new Map();   // video id -> {price, fileId, exp}
    async function canStreamVideo(vid, tok) {
        let m = vmeta.get(String(vid));
        if (!m || m.exp < Date.now()) {
            const { data } = await supabase.from('videos').select('price').eq('id', vid).maybeSingle();
            if (!data) return { ok: false };
            m = { price: data.price || 0, exp: Date.now() + 5 * 60000 };
            if (m.price > 0) {
                const { data: a } = await supabase.from('paid_assets').select('file_id').eq('content_type', 'video').eq('content_id', String(vid)).maybeSingle();
                m.fileId = a && a.file_id;
            }
            vmeta.set(String(vid), m); if (vmeta.size > 1500) vmeta.delete(vmeta.keys().next().value);
        }
        if (!(m.price > 0)) return { ok: true };
        if (!m.fileId || !checkStream(vid, tok)) return { ok: false };
        return { ok: true, paid: true, fileId: m.fileId };
    }

    // ---------- creation helpers (called by createPost / createVideo) ----------
    async function parsePriceInput(body) {
        const price = parseInt(body.price) || 0;
        if (price <= 0) return { price: 0 };
        const s = publicConfig(await getSettings());
        if (!s.enabled) return { error: 'Paid posts are turned off right now.' };
        if (price < s.min_price || price > s.max_price) return { error: `Price must be between ${s.min_price} and ${s.max_price} Stars.` };
        let preview = typeof body.previewBase64 === 'string' ? body.previewBase64 : '';
        if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(preview) || preview.length > 90000) preview = '';
        return { price, preview };
    }
    async function savePaidAssets(kind, id, fields) {
        await supabase.from('paid_assets').upsert([{ content_type: kind, content_id: String(id), image_urls: fields.image_urls || [], file_id: fields.file_id || null }]);
    }
    const dropPaidAssets = (kind, id) => supabase.from('paid_assets').delete().eq('content_type', kind).eq('content_id', String(id)).then(() => {}, () => {});

    // ---------- auth helper for wallet endpoints ----------
    async function walletUser(req, res) {
        const u = validateTGData(req.body.initData);
        if (!u || !isRealTgId(u.id)) { res.status(403).json({ error: 'Open the app in Telegram to use Stars.' }); return null; }
        return String(u.id);
    }
    async function balanceOf(uid) {
        const { data, error } = await supabase.from('users').select('stars_balance, stars_earned').eq('tg_id', uid).maybeSingle();
        if (error) return { balance: 0, earned: 0, missing: true };
        return { balance: Number(data && data.stars_balance) || 0, earned: Number(data && data.stars_earned) || 0 };
    }

    app.get('/api/stars/health', async (req, res) => {
        const chk = async (q) => { const { error } = await q; return error ? error.message : null; };
        const errs = [await chk(supabase.from('users').select('stars_balance').limit(1)), await chk(supabase.from('posts').select('price, preview_url').limit(1)), await chk(supabase.from('videos').select('price').limit(1)),
            await chk(supabase.from('paid_assets').select('content_id').limit(1)), await chk(supabase.from('unlocks').select('user_id').limit(1)), await chk(supabase.from('star_txns').select('id').limit(1)), await chk(supabase.from('star_deposits').select('id').limit(1))].filter(Boolean);
        res.json({ ready: !errs.length, errors: errs.slice(0, 3) });
    });
    app.get('/api/stars/config', async (req, res) => { res.set('Cache-Control', 'public, max-age=30'); res.json(publicConfig(await getSettings())); });

    app.post('/api/stars/wallet', async (req, res) => {
        const uid = await walletUser(req, res); if (!uid) return;
        try {
            const [bal, tx, dep, pay] = await Promise.all([
                balanceOf(uid),
                supabase.from('star_txns').select('id, kind, amount, content_type, content_id, note, created_at').eq('user_id', uid).order('created_at', { ascending: false }).limit(40),
                supabase.from('star_deposits').select('id, stars, status, created_at').eq('user_id', uid).eq('status', 'pending').order('created_at', { ascending: false }).limit(3),
                supabase.from('star_payouts').select('id, stars, amount, currency, status, admin_note, created_at').eq('user_id', uid).order('created_at', { ascending: false }).limit(10)
            ]);
            if (tx.error || dep.error || bal.missing) { console.error('Stars schema check failed:', (tx.error || dep.error || {}).message); return res.status(500).json({ error: 'Stars are not set up yet. Admin: run sql/16_stars_paid.sql in Supabase.' }); }
            res.json({ ...bal, txns: tx.data || [], pending: dep.data || [], payouts: pay.data || [], config: publicConfig(await getSettings()) });
        } catch (e) { res.status(500).json({ error: e.message || String(e) }); }
    });

    app.post('/api/stars/unlock', async (req, res) => {
        const uid = await walletUser(req, res); if (!uid) return;
        const type = req.body.type === 'video' ? 'video' : 'post', id = String(req.body.id || '');
        if (!id) return res.status(400).json({ error: 'Missing id' });
        try {
            if (type === 'post') { const { data: pc } = await supabase.from('posts').select('type').eq('id', id).maybeSingle(); if (pc && pc.type === 'channel') return res.status(400).json({ error: 'This post is paid inside Telegram — unlock it in the channel.' }); }
            const s = await getSettings();
            const { data, error } = await supabase.rpc('unlock_content', { p_user: uid, p_type: type, p_id: id, p_fee: Math.round(num(s.stars_fee_pct, 10)) });
            if (error) throw error;
            if (!data.ok) return res.status(data.error === 'insufficient' ? 402 : 400).json({ error: data.error, ...(await balanceOf(uid)) });
            const out = { success: true, balance: data.balance };
            if (type === 'video') out.stream_url = `/api/videoStream/${id}?t=${signStream(id, uid)}`;
            else { const { data: a } = await supabase.from('paid_assets').select('image_urls').eq('content_type', 'post').eq('content_id', id).maybeSingle(); out.image_urls = (a && a.image_urls) || []; }
            if (!data.already && data.author && isRealTgId(data.author) && bot) {
                bot.telegram.sendMessage(data.author, `⭐ Someone unlocked your ${type === 'video' ? 'reel' : 'post'} for ${data.price} Stars.`, { disable_notification: true }).catch(() => {});
            }
            res.json(out);
        } catch (e) { res.status(500).json({ error: e.message || String(e) }); }
    });

    app.post('/api/stars/tip', async (req, res) => {
        const uid = await walletUser(req, res); if (!uid) return;
        const type = req.body.type === 'video' ? 'video' : 'post', id = String(req.body.id || ''), amount = parseInt(req.body.amount) || 0;
        try {
            const s = await getSettings();
            const args = { p_user: uid, p_type: type, p_id: id, p_amount: amount, p_fee: Math.round(num(s.stars_fee_pct, 10)) };
            let { data, error } = await supabase.rpc('tip_stars', { ...args, p_anon: req.body.show === false });
            if (error && /p_anon|function|schema cache/i.test(error.message || '')) ({ data, error } = await supabase.rpc('tip_stars', args));   // sql/17 not run yet
            if (error) throw error;
            if (!data.ok) return res.status(data.error === 'insufficient' ? 402 : 400).json({ error: data.error, ...(await balanceOf(uid)) });
            res.json({ success: true, balance: data.balance });
        } catch (e) { res.status(500).json({ error: e.message || String(e) }); }
    });

    // Top Senders of one post/reel (people who chose "Show me in Top Senders")
    app.post('/api/stars/topSenders', async (req, res) => {
        const type = req.body.type === 'video' ? 'video' : 'post', id = String(req.body.id || '');
        try {
            const { data } = await supabase.from('star_txns').select('user_id, amount, note').eq('kind', 'tip').eq('content_type', type).eq('content_id', id).limit(500);
            const agg = new Map();
            (data || []).forEach(r => { const a = agg.get(r.user_id) || { id: r.user_id, stars: 0, anon: false }; a.stars += Math.abs(Number(r.amount)); if (r.note === 'anon') a.anon = true; agg.set(r.user_id, a); });
            const top = [...agg.values()].sort((a, b) => b.stars - a.stars).slice(0, 3);
            const meta = await getUserMetaBatch(top.filter(x => !x.anon).map(x => x.id));
            res.json(top.map(x => x.anon ? { name: 'Anonymous', stars: x.stars, anon: true } : { name: (meta[x.id] && meta[x.id].name) || 'User', photo: (meta[x.id] && meta[x.id].photo_url) || '', stars: x.stars }));
        } catch (e) { res.json([]); }
    });

    // ---------- Payout (withdraw) ----------
    app.post('/api/stars/payout', async (req, res) => {
        const uid = await walletUser(req, res); if (!uid) return;
        try {
            const s = await getSettings(), cfg = publicConfig(s);
            if (!cfg.payout_on) return res.status(503).json({ error: 'Withdrawals are paused for now. Please try again later.' });
            const stars = parseInt(req.body.stars) || 0; let dest = String(req.body.dest || '').trim().slice(0, 120);
            if (stars < cfg.payout_min) return res.status(400).json({ error: `Minimum withdrawal is ${cfg.payout_min} Stars.` });
            if (!dest) dest = 'xRocket \u00b7 Telegram ID ' + uid;
            const amount = Math.floor((stars / cfg.payout_per_unit) * 100) / 100;
            const { data, error } = await supabase.rpc('request_payout', { p_user: uid, p_stars: stars, p_amount: amount, p_currency: s.xrocket_currency, p_dest: dest });
            if (error) throw error;
            if (!data.ok) return res.status(data.error === 'insufficient' ? 402 : 400).json({ error: data.error === 'too_many' ? 'You already have 3 pending withdrawals.' : data.error, ...(await balanceOf(uid)) });
            let auto = false;
            if (s.stars_payout_auto !== 'false' && s.xrocket_key && isRealTgId(uid)) auto = (await autoPayout(data.id)).ok;   // instant xRocket transfer; falls back to manual review
            res.json({ success: true, id: data.id, balance: data.balance, amount, currency: s.xrocket_currency, auto });
        } catch (e) { res.status(500).json({ error: (/star_payouts|request_payout|schema cache/i.test(e.message || '') ? 'Withdrawals are not set up yet. Admin: run sql/18_stars_payouts.sql.' : (e.message || String(e))) }); }
    });
    // Sends the money straight to the user's xRocket account (by Telegram ID). Idempotent thanks to the fixed client id.
    async function autoPayout(id) {
        const { data: po } = await supabase.from('star_payouts').select('*').eq('id', id).maybeSingle();
        if (!po || po.status !== 'pending') return { ok: false, error: 'not pending' };
        const s = await getSettings(true);
        const cid = `payout-${po.id}`, desc = `SnapPages withdrawal #${po.id}`;
        const cur = po.currency || s.xrocket_currency, amt = Number(po.amount), uidn = Number(po.user_id);
        // The exact field names differ between xRocket API generations — try the likely shapes, newest first, and keep every answer for the admin
        const attempts = [];
        const amtStr = String(Number(amt.toFixed(8)));          // docs: amount is a STRING, e.g. "1.23"
        if (s.xrocket_style !== 'legacy') {
            attempts.push(['v1', '/payouts', { targetType: 'telegram_user_id', target: String(po.user_id), asset: cur, amount: amtStr, description: desc, clientPayoutId: cid }]);
            attempts.push(['v1', '/payouts', { targetType: 'telegram_user_id', target: String(po.user_id), asset: cur, amount: amtStr }]);   // minimal body
        }
        if (s.xrocket_style !== 'v1') attempts.push(['legacy', '/app/transfer', { tgUserId: uidn, currency: cur, amount: amt, transferId: cid, description: desc }]);
        let r = { ok: false }; const errs = [];
        for (const [st, path, body] of attempts) {
            r = await xr(s, 'POST', { v1: path, legacy: path }, body, st);
            if (r.ok) break;
            errs.push(`${st}${path}: ${r.status || ''} ${r.error || ''}`.trim());
            if (/duplicate|already/i.test(String(r.error || ''))) break;
            if (/insufficient|not enough|balance/i.test(String(r.error || ''))) break;   // retrying other shapes will not help
        }
        if (!r.ok) r.error = errs.join(' | ');
        const dup = r && /duplicate|already/i.test(String(r.error || ''));            // the first attempt went through
        const failed = r.ok && r.data && String(r.data.status || '').toLowerCase() === 'failed';
        if ((r.ok && !failed) || dup) {
            const { data } = await supabase.rpc('resolve_payout', { p_id: po.id, p_action: 'paid', p_note: 'Sent automatically via xRocket' });
            if (data && data.ok && bot && isRealTgId(po.user_id)) bot.telegram.sendMessage(po.user_id, `\u2705 Your withdrawal of ${po.stars} Stars (${po.amount} ${po.currency || ''}) was sent to your xRocket wallet.`).catch(() => {});
            return { ok: true };
        }
        const msg = ('auto-send failed: ' + (r.error || r.status || 'unknown')).slice(0, 480);
        console.error('xRocket payout failed:', JSON.stringify(r).slice(0, 400));
        await supabase.from('star_payouts').update({ admin_note: msg }).eq('id', po.id).eq('status', 'pending');
        return { ok: false, error: msg };
    }
    app.post('/api/admin/stars/payoutAuto', requireAdminUser, requireAdminPassword, async (req, res) => {
        const r = await autoPayout(parseInt(req.body.id) || 0);
        if (!r.ok) return res.status(502).json({ error: r.error });
        res.json({ success: true });
    });
    app.post('/api/admin/stars/payouts', requireAdminUser, requireAdminPassword, async (req, res) => {
        const { data, error } = await supabase.from('star_payouts').select('*').order('created_at', { ascending: false }).limit(40);
        if (error) return res.status(500).json({ error: error.message });
        const meta = await getUserMetaBatch([...new Set((data || []).map(p => p.user_id))]);
        res.json((data || []).map(p => ({ ...p, name: (meta[p.user_id] && meta[p.user_id].name) || '' })));
    });
    app.post('/api/admin/stars/payoutResolve', requireAdminUser, requireAdminPassword, async (req, res) => {
        const { data, error } = await supabase.rpc('resolve_payout', { p_id: parseInt(req.body.id) || 0, p_action: req.body.action, p_note: String(req.body.note || '').slice(0, 200) || null });
        if (error) return res.status(500).json({ error: error.message });
        if (!data.ok) return res.status(400).json({ error: data.error });
        if (bot && isRealTgId(data.user)) bot.telegram.sendMessage(data.user, data.status === 'paid' ? `✅ Your withdrawal of ${data.stars} Stars was paid.` : `↩️ Your withdrawal of ${data.stars} Stars was declined and the Stars were returned to your wallet.${req.body.note ? '\n' + req.body.note : ''}`).catch(() => {});
        res.json({ success: true });
    });

    // ---------- xRocket client ----------
    // Two API generations exist. 'auto' tries the current one (Bearer token) and falls back to the legacy one (Rocket-Pay-Key).
    const trim = (u) => String(u || '').replace(/\/+$/, '');
    async function xr(s, method, p, body, only) {
        const styles = only ? [only] : (s.xrocket_style === 'auto' ? ['v1', 'legacy'] : [s.xrocket_style]);
        let last = null;
        for (const st of styles) {
            const base = st === 'legacy' && /pay\.api\./.test(s.xrocket_base) ? 'https://pay.xrocket.tg' : trim(s.xrocket_base);
            const url = st === 'v1' ? `${base}/api/v1${p.v1}` : `${base}${p.legacy}`;
            const payload = body && (body.v1 || body.legacy) ? body[st] : body;
            const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
            if (st === 'v1') headers.Authorization = `Bearer ${s.xrocket_key}`; else headers['Rocket-Pay-Key'] = s.xrocket_key;
            try {
                const r = await fetch(url, { method, headers, body: payload ? JSON.stringify(payload) : undefined, signal: AbortSignal.timeout(12000) });
                const raw = await r.text().catch(() => ''); let j = {}; try { j = JSON.parse(raw); } catch (e) {}
                if (r.ok && j.success !== false) return { ok: true, data: j.data || j, style: st };
                const em = (j.errors ? JSON.stringify(j.errors) : '') || j.detail || j.message || j.error || (Array.isArray(j.errors) ? JSON.stringify(j.errors) : '');
                last = { ok: false, status: r.status, error: (Array.isArray(em) ? em.join('; ') : (typeof em === 'object' && em ? JSON.stringify(em) : em)) || (raw ? raw.replace(/\s+/g, ' ').slice(0, 300) : '') || `HTTP ${r.status}` };
                if (![401, 403, 404, 405].includes(r.status)) break;      // real error: do not retry on the other API
            } catch (e) { last = { ok: false, error: e.message || String(e) }; }
        }
        return last || { ok: false, error: 'xRocket unreachable' };
    }
    const pick = (o, keys) => { for (const k of keys) if (o && o[k] !== undefined && o[k] !== null) return o[k]; };
    // Current API: d.links = { telegramBotLink, telegramMiniAppLink, webLink }. Legacy API: d.link
    const invoiceLink = (d) => (d && d.links && (d.links.telegramBotLink || d.links.telegramMiniAppLink || d.links.webLink)) || pick(d, ['link', 'payLink', 'pay_link', 'paymentLink']) || (typeof d.url === 'string' ? d.url : undefined);
    const invoiceWebLink = (d) => (d && d.links && (d.links.webLink || d.links.telegramMiniAppLink)) || null;
    // List endpoints answer { items | data | invoices | results: [...] } or a bare array
    const firstOf = (d) => Array.isArray(d) ? d[0] : (d && (['items', 'data', 'invoices', 'results'].map(k => d[k]).find(Array.isArray) || [])[0]);
    const invoicePaid = (d) => {
        const st = String(pick(d, ['status', 'state']) || '').toLowerCase();
        return d.paid === true || ['paid', 'completed', 'success', 'succeeded'].includes(st) || (pick(d, ['activationsLeft']) === 0 && Number(pick(d, ['totalActivations', 'numPayments'])) > 0);   // 'partially_paid' is NOT paid
    };
    const invoiceDead = (d) => ['expired', 'cancelled', 'canceled', 'failed'].includes(String(pick(d, ['status', 'state']) || '').toLowerCase());

    app.post('/api/stars/createDeposit', async (req, res) => {
        const uid = await walletUser(req, res); if (!uid) return;
        try {
            const s = await getSettings(), cfg = publicConfig(s);
            if (!cfg.topup_on) return res.status(503).json({ error: 'Top Up is paused for now. Please try again later.' });
            if (!cfg.enabled || !s.xrocket_key) return res.status(503).json({ error: 'Adding Stars is not available yet.' });
            const stars = parseInt(req.body.stars) || 0;
            if (stars < cfg.min_deposit || stars > 100000) return res.status(400).json({ error: `Choose between ${cfg.min_deposit} and 100000 Stars.` });
            const { count } = await supabase.from('star_deposits').select('id', { count: 'exact', head: true }).eq('user_id', uid).eq('status', 'pending');
            if ((count || 0) >= 5) return res.status(429).json({ error: 'You have several unpaid invoices. Pay or wait for them to expire.' });
            const amount = Math.round((stars / cfg.per_unit) * 1e6) / 1e6;
            const { data: row, error: e1 } = await supabase.from('star_deposits').insert([{ user_id: uid, stars, amount, currency: s.xrocket_currency }]).select('id').single();
            if (e1) throw e1;
            const host = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || '';
            const desc = `${stars} SnapPages Stars`, cid = `dep-${row.id}`;
            const r = await xr(s, 'POST', { v1: '/invoices', legacy: '/tg-invoices' }, {
                // current API (docs: InvoiceDto): priceAmount / priceCurrency / clientInvoiceId / expiresIn (ms) / callback / url
                v1: { priceAmount: amount.toFixed(6).replace(/\.?0+$/, ''), priceCurrency: s.xrocket_currency, clientInvoiceId: cid, description: desc, expiresIn: 3600000,
                      ...(host ? { callback: { callbackUrl: `${host}/api/stars/webhook`, payload: `dep:${row.id}` } } : {}), url: { successUrl: 'https://t.me/SnapPagesBot/app' } },
                // legacy API
                legacy: { amount, currency: s.xrocket_currency, numPayments: 1, description: desc, expiredIn: 3600, payload: `dep:${row.id}` }
            });
            const link = r.ok && invoiceLink(r.data);
            if (!link) {
                await supabase.from('star_deposits').update({ status: 'expired' }).eq('id', row.id);
                console.error('xRocket createInvoice failed:', JSON.stringify(r).slice(0, 400));
                return res.status(502).json({ error: 'Could not create the payment. Please try again later.' });
            }
            await supabase.from('star_deposits').update({ ext_id: String(pick(r.data, ['id', 'invoiceId']) || (firstOf(r.data) && firstOf(r.data).id) || ''), pay_url: link }).eq('id', row.id);
            res.json({ success: true, id: row.id, url: link, web: invoiceWebLink(r.data), amount, currency: s.xrocket_currency });
        } catch (e) { res.status(500).json({ error: e.message || String(e) }); }
    });

    // Current API: GET /invoice?invoiceId=… (or ?clientInvoiceId=…) per the docs; older paths kept as fallbacks. Legacy API: /tg-invoices/{id}
    async function lookupInvoice(s, dep) {
        const id = encodeURIComponent(dep.ext_id), cid = encodeURIComponent('dep-' + dep.id);
        const tries = [];
        if (s.xrocket_style !== 'legacy') ['v1'].forEach(st => [`/invoices?ids=${id}`, `/invoice?invoiceId=${id}`, `/invoice?clientInvoiceId=${cid}`, `/invoices/${id}`].forEach(p => tries.push([st, p])));
        if (s.xrocket_style !== 'v1') tries.push(['legacy', `/tg-invoices/${id}`]);
        let last = { ok: false };
        for (const [st, p] of tries) {
            const r = await xr(s, 'GET', { v1: p, legacy: p }, null, st);
            if (r.ok) { const d = Array.isArray(r.data) || (r.data && (r.data.items || r.data.invoices || r.data.results)) ? firstOf(r.data) : r.data; if (d && typeof d === 'object') return { ok: true, data: d }; }
            last = r;
            if (r.status && ![400, 401, 403, 404, 405].includes(r.status)) break;
        }
        return last;
    }
    // Never trusts the caller: re-reads the invoice from xRocket and credits only if xRocket says it is paid. Idempotent (credit_deposit).
    async function verifyDeposit(dep) {
        if (!dep || dep.status !== 'pending' || !dep.ext_id) return dep && dep.status;
        const s = await getSettings(); if (!s.xrocket_key) return 'pending';
        const r = await lookupInvoice(s, dep);
        if (!r.ok) return 'pending';
        if (invoicePaid(r.data)) {
            const { data } = await supabase.rpc('credit_deposit', { p_id: dep.id });
            if (data && data.ok && bot && isRealTgId(dep.user_id)) bot.telegram.sendMessage(dep.user_id, `⭐ ${dep.stars} Stars added to your wallet.`, { disable_notification: true }).catch(() => {});
            return 'paid';
        }
        if (invoiceDead(r.data)) { await supabase.from('star_deposits').update({ status: 'expired' }).eq('id', dep.id).eq('status', 'pending'); return 'expired'; }
        return 'pending';
    }
    app.post('/api/stars/checkDeposit', async (req, res) => {
        const uid = await walletUser(req, res); if (!uid) return;
        try {
            const { data: dep } = await supabase.from('star_deposits').select('*').eq('id', parseInt(req.body.id) || 0).eq('user_id', uid).maybeSingle();
            if (!dep) return res.status(404).json({ error: 'Not found' });
            const status = await verifyDeposit(dep);
            res.json({ status, ...(await balanceOf(uid)) });
        } catch (e) { res.status(500).json({ error: e.message || String(e) }); }
    });
    // xRocket may call this when an invoice is paid. The body is ignored except as a hint of which deposit to re-check.
    app.post('/api/stars/webhook', async (req, res) => {
        res.json({ ok: true });
        try {
            const b = req.body || {}, d = b.data || b;
            const hint = String(pick(d, ['id', 'invoiceId']) || '');
            const cid = String(pick(d, ['clientInvoiceId', 'payload']) || '');
            let q = supabase.from('star_deposits').select('*').eq('status', 'pending').limit(1);
            const m = cid.match(/(\d+)$/);
            if (hint) q = q.eq('ext_id', hint); else if (m) q = q.eq('id', parseInt(m[1])); else return;
            const { data } = await q; if (data && data[0]) await verifyDeposit(data[0]);
        } catch (e) {}
    });
    // Safety net: every minute re-check recent unpaid invoices; expire stale ones
    setInterval(async () => {
        try {
            const s = await getSettings(); if (!s.xrocket_key) return;
            const { data } = await supabase.from('star_deposits').select('*').eq('status', 'pending').gt('created_at', new Date(Date.now() - 3 * 3600e3).toISOString()).limit(15);
            for (const d of data || []) await verifyDeposit(d);
            if (s.stars_payout_auto !== 'false') {      // retry payouts whose first automatic send failed (safe: fixed client id)
                const { data: pp } = await supabase.from('star_payouts').select('id').eq('status', 'pending').like('admin_note', 'auto-send failed%').gt('created_at', new Date(Date.now() - 24 * 3600e3).toISOString()).limit(3);
                for (const x of pp || []) await autoPayout(x.id);
            }
            await supabase.from('star_deposits').update({ status: 'expired' }).eq('status', 'pending').lt('created_at', new Date(Date.now() - 3 * 3600e3).toISOString());
        } catch (e) {}
    }, 60 * 1000);

    // ---------- Admin ----------
    app.post('/api/admin/stars/get', requireAdminUser, requireAdminPassword, async (req, res) => {
        try {
            const s = await getSettings(true);
            const [dep, paid, vol, pend, top] = await Promise.all([
                supabase.from('star_deposits').select('stars').eq('status', 'paid'),
                supabase.from('unlocks').select('user_id', { count: 'exact', head: true }),
                supabase.from('users').select('stars_balance').gt('stars_balance', 0),
                supabase.from('star_deposits').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
                supabase.from('star_deposits').select('id, user_id, stars, status, created_at').order('created_at', { ascending: false }).limit(15)
            ]);
            res.json({
                settings: { ...s, xrocket_key: s.xrocket_key ? '••••' + s.xrocket_key.slice(-4) : '' }, key_set: !!s.xrocket_key,
                stats: { deposited: (dep.data || []).reduce((a, r) => a + Number(r.stars), 0), deposits: (dep.data || []).length, unlocks: paid.count || 0, in_wallets: (vol.data || []).reduce((a, r) => a + Number(r.stars_balance), 0), pending: pend.count || 0 },
                recent: top.data || [], webhook: `${process.env.RENDER_EXTERNAL_URL || ''}/api/stars/webhook`
            });
        } catch (e) { res.status(500).json({ error: e.message || String(e) }); }
    });
    app.post('/api/admin/stars/save', requireAdminUser, requireAdminPassword, async (req, res) => {
        try {
            const inp = req.body.settings || {}, rows = [];
            for (const k of SETTING_KEYS) {
                if (inp[k] === undefined) continue;
                let v = String(inp[k]).trim();
                if (k === 'xrocket_key' && (v === '' || v.startsWith('••••'))) continue;     // blank = keep the saved key
                if (k === 'xrocket_base') { if (!/^https:\/\/[\w.-]+(\/.*)?$/.test(v)) return res.status(400).json({ error: 'API base must be an https URL' }); v = trim(v); }
                if (k === 'xrocket_style' && !['auto', 'v1', 'legacy'].includes(v)) return res.status(400).json({ error: 'Bad API style' });
                if (k === 'stars_per_unit' && !(num(v, 0) > 0)) return res.status(400).json({ error: 'Stars per 1 unit must be > 0' });
                if (k === 'stars_fee_pct' && !(num(v, -1) >= 0 && num(v, -1) <= 90)) return res.status(400).json({ error: 'Fee must be 0–90' });
                if (['stars_topup_on', 'stars_payout_on', 'stars_payout_auto', 'maintenance_mode'].includes(k)) v = v === 'true' ? 'true' : 'false';
                if (k === 'maintenance_msg') v = v.slice(0, 200);
                if (k === 'payout_per_unit' && !(num(v, 0) > 0)) return res.status(400).json({ error: 'Payout rate must be > 0' });
                if (k === 'payout_min' && !(parseInt(v) >= 1)) return res.status(400).json({ error: 'Minimum payout must be >= 1' });
                if (k === 'stars_packs' && !v.split(',').every(x => parseInt(x) > 0)) return res.status(400).json({ error: 'Packs: comma separated numbers' });
                rows.push({ key: k, value: v });
            }
            if (rows.length) { const { error } = await supabase.from('app_settings').upsert(rows); if (error) throw error; }
            await getSettings(true);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message || String(e) }); }
    });
    app.post('/api/admin/stars/test', requireAdminUser, requireAdminPassword, async (req, res) => {
        const s = await getSettings(true);
        if (!s.xrocket_key) return res.status(400).json({ error: 'Save the xRocket API key first.' });
        const r = await xr(s, 'GET', { v1: '/app-info', legacy: '/app/info' });
        if (!r.ok) return res.status(502).json({ error: `xRocket said: ${r.error || r.status}` });
        res.json({ success: true, style: r.style, info: r.data });
    });
    // Creates a real (unpaid) 1-minute-test invoice so the admin can see xRocket's exact answer or error
    app.post('/api/admin/stars/testInvoice', requireAdminUser, requireAdminPassword, async (req, res) => {
        const s = await getSettings(true);
        if (!s.xrocket_key) return res.status(400).json({ error: 'Save the xRocket API key first.' });
        const amount = Math.round((10 / num(s.stars_per_unit, 50)) * 1e6) / 1e6;
        const r = await xr(s, 'POST', { v1: '/invoices', legacy: '/tg-invoices' }, {
            v1: { priceAmount: String(amount), priceCurrency: s.xrocket_currency, clientInvoiceId: 'test-' + Date.now(), description: 'SnapPages test invoice', expiresIn: 300000 },
            legacy: { amount, currency: s.xrocket_currency, numPayments: 1, description: 'SnapPages test invoice', expiredIn: 300 }
        });
        if (!r.ok) return res.status(502).json({ error: `xRocket said: ${r.error || r.status}` });
        res.json({ success: true, style: r.style, link: invoiceLink(r.data) || null, raw: JSON.stringify(r.data).slice(0, 400) });
    });
    app.post('/api/admin/stars/grant', requireAdminUser, requireAdminPassword, async (req, res) => {
        const uid = String(req.body.userId || '').trim(), amt = parseInt(req.body.amount) || 0;
        if (!isRealTgId(uid) || !amt) return res.status(400).json({ error: 'Need a numeric Telegram ID and a non-zero amount' });
        const { data, error } = await supabase.rpc('stars_adjust', { p_user: uid, p_amount: amt, p_kind: 'admin', p_note: 'Admin adjustment' });
        if (error) return res.status(500).json({ error: error.message });
        if (!data.ok) return res.status(400).json({ error: data.error === 'insufficient' ? 'Not enough balance (or unknown user)' : data.error });
        res.json({ success: true, balance: data.balance });
    });

    return { paywall, canStreamVideo, parsePriceInput, savePaidAssets, dropPaidAssets, getSettings };
}
module.exports = { register };
