require('dotenv').config();
const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const cors = require('cors');
const path = require('path');

const app = express();

// Gzip/brotli-style compression for HTML, CSS, JS and JSON (falls back silently if the package isn't installed)
try { app.use(require('compression')()); } catch (e) { console.warn('compression not installed — responses will be uncompressed'); }

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const bot = new Telegraf(process.env.BOT_TOKEN);
const FOUNDER_ID = process.env.FOUNDER_ID || '7767338426';   // gets the animated Founder profile
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme";
// Images no longer go through ImgBB at all (see uploadImageToTelegram below) — ImgBB was
// blacklisting every request from this deployment regardless of which API key was used.
// A private channel (bot must be admin) used purely as storage for user-uploaded Shorts videos,
// so raw video bytes never sit in Supabase — only the Telegram file_id is stored.
const ENV_STORAGE_CHANNEL_ID = process.env.STORAGE_CHANNEL_ID;
// Storage channel can be set from the admin panel (app_settings.storage_channel_id); env var is the fallback
let storageCache = { id: ENV_STORAGE_CHANNEL_ID || null, ts: 0 };
async function getStorageChannel(force) {
    if (!force && Date.now() - storageCache.ts < 60000) return storageCache.id;
    try {
        const { data } = await supabase.from('app_settings').select('value').eq('key', 'storage_channel_id').maybeSingle();
        storageCache = { id: (data && data.value) || ENV_STORAGE_CHANNEL_ID || null, ts: Date.now() };
    } catch (e) { storageCache.ts = Date.now(); }
    return storageCache.id;
}
const MAX_VIDEO_BYTES = 18 * 1024 * 1024; // 18MB — Telegram Bot API can't reliably stream files near/above ~20MB
const MAX_VIDEOS_IN_DB = 300;

// ================= Referral Level Mapping =================
const getLevelData = (refs) => {
    if (refs >= 3) return { level: 3, channels: 5 };
    if (refs >= 2) return { level: 2, channels: 3 };
    return { level: 1, channels: 1 };
};

// ---- Browser guests: opened outside Telegram → a signed "guest.<id>.<sig>" token stands in for initData ----
const guestSig = (id) => crypto.createHmac('sha256', 'SnapGuest' + (process.env.BOT_TOKEN || '')).update(id).digest('hex').slice(0, 24);
const makeGuestToken = () => { const id = 'g' + crypto.randomBytes(6).toString('hex'); return `guest.${id}.${guestSig(id)}`; };
const isRealTgId = (id) => /^\d+$/.test(String(id));

const validateTGData = (initData) => {
    if (typeof initData === 'string' && initData.startsWith('guest.')) {
        const [, id, sig] = initData.split('.');
        if (!id || !sig || sig !== guestSig(id)) return null;
        return { id, first_name: 'Guest ' + id.slice(-4).toUpperCase(), is_guest: true };
    }
    try {
        const urlParams = new URLSearchParams(initData);
        const hash = urlParams.get('hash');
        urlParams.delete('hash');
        urlParams.sort();
        let dataCheckString = '';
        for (const [key, value] of urlParams.entries()) dataCheckString += `${key}=${value}\n`;
        const secret = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN).digest();
        const calcHash = crypto.createHmac('sha256', secret).update(dataCheckString.slice(0, -1)).digest('hex');
        if (calcHash !== hash) return null;
        return JSON.parse(urlParams.get('user'));
    } catch (e) { return null; }
};

// ================= Admin Password Gate =================
// Every /api/admin/* route requires { adminPassword } in the body, checked against
// process.env.ADMIN_PASSWORD. This is a deliberately simple, stateless check per the spec
// ("password set in Render environment, checked by server on each admin login").
function requireAdminPassword(req, res, next) {
    const { adminPassword } = req.body || {};
    if (!adminPassword || adminPassword !== ADMIN_PASSWORD) {
        return res.status(403).json({ error: "Invalid admin password" });
    }
    next();
}

// Extra guard: when opened from inside the Telegram app, the calling user must also be
// flagged is_admin in DB. When opened directly in a browser (e.g. visiting /admin by URL),
// there's no Telegram initData to check at all — in that case we fall back to the
// ADMIN_PASSWORD alone (still enforced by requireAdminPassword right after this).
async function requireAdminUser(req, res, next) {
    const initData = req.body && req.body.initData;
    if (!initData) {
        return next();
    }
    try {
        const tgUser = validateTGData(initData);
        if (!tgUser) return res.status(403).json({ error: "Unauthorized" });
        const { data: user } = await supabase.from('users').select('is_admin').eq('tg_id', tgUser.id.toString()).maybeSingle();
        if (!user || !user.is_admin) return res.status(403).json({ error: "Not an admin" });
        req.tgUser = tgUser;
        next();
    } catch (e) {
        res.status(403).json({ error: "Unauthorized" });
    }
}

// ================= Telegram-native image hosting (replaces ImgBB) =================
// ImgBB started rejecting every request from this deployment with "You have been forbidden
// to use this website" (error 103) — a known ImgBB behavior of blacklisting cloud-hosting IP
// ranges (Render, AWS, etc), unrelated to which API key is used. Rather than depend on a
// third-party host at all, images are now stored the same way videos already are: as a
// Telegram file_id (in the private storage channel for user uploads, or referenced directly
// from the origin channel for channel posts), streamed on demand via /api/tgImage/:fileId.
function tgImageUrl(fileId) {
    return `/api/tgImage/${fileId}`;
}

async function uploadImageToTelegram(base64Str) {
    const STORAGE_CHANNEL_ID = await getStorageChannel();
    if (!STORAGE_CHANNEL_ID) {
        console.error("uploadImageToTelegram: no storage channel configured (Admin panel → Storage Channel).");
        return null;
    }
    try {
        let cleanBase64 = typeof base64Str === 'string' ? base64Str : String(base64Str);
        if (cleanBase64.includes(',')) {
            cleanBase64 = cleanBase64.split(',')[1];
        }
        const buffer = Buffer.from(cleanBase64, 'base64');

        const sentMsg = await bot.telegram.sendPhoto(STORAGE_CHANNEL_ID, { source: buffer, filename: `img_${Date.now()}.jpg` });
        const sizes = sentMsg.photo;
        if (!sizes || sizes.length === 0) {
            console.error("uploadImageToTelegram: sendPhoto succeeded but returned no photo sizes.");
            return null;
        }
        const fileId = sizes[sizes.length - 1].file_id; // largest resolution
        return tgImageUrl(fileId);
    } catch (e) {
        console.error("uploadImageToTelegram failed:", e.message || e);
        return null;
    }
}

// ================= Bot Notification Helper (with Inline WebApp Button) =================
// Anti-spam + Telegram flood protection: at most 15 notifications per user per hour
const notifyLog = new Map();
function notifyAllowed(tgId) {
    const now = Date.now();
    const recent = (notifyLog.get(String(tgId)) || []).filter(t => now - t < 3600 * 1000);
    if (recent.length >= 15) { notifyLog.set(String(tgId), recent); return false; }
    recent.push(now);
    notifyLog.set(String(tgId), recent);
    if (notifyLog.size > 20000) notifyLog.delete(notifyLog.keys().next().value);
    return true;
}

// Referrer id from a start param: "ref_123" (bot link) or "profile_55_ref_123" / "post_9_ref_123" (shared links)
function extractRef(param, selfId) {
    const m = /(?:^|_)ref_(\d+)/.exec(String(param || ''));
    return m && m[1] !== String(selfId) ? m[1] : null;
}

// Per-user "Notifications On/Off" switch (users.notify_enabled, sql/12). Cached 5 min; missing column = on.
const notifyPrefCache = new Map();
async function isNotifyOn(id) {
    const hit = notifyPrefCache.get(String(id));
    if (hit && Date.now() - hit.ts < 300000) return hit.on;
    let on = true;
    try {
        const { data, error } = await supabase.from('users').select('notify_enabled').eq('tg_id', String(id)).maybeSingle();
        if (!error && data && data.notify_enabled === false) on = false;
    } catch (e) { /* keep on */ }
    if (notifyPrefCache.size > 5000) notifyPrefCache.clear();
    notifyPrefCache.set(String(id), { on, ts: Date.now() });
    return on;
}

async function sendTelegramNotification(targetTgId, text, startappParam = "") {
    if (!targetTgId || !isRealTgId(targetTgId)) return;   // browser guests can't receive Telegram DMs
    if (!notifyAllowed(targetTgId)) return;
    if (!(await isNotifyOn(targetTgId))) return;           // user switched notifications off in Settings
    const base = process.env.MINI_APP_URL;
    // Main button opens the in-app Notifications page; second button (when there is one) opens the item itself
    const rows = [[Markup.button.webApp('🔔 Open Notifications', `${base}?startapp=notifications`)]];
    if (startappParam && startappParam !== 'notifications' && startappParam !== 'settings') {
        rows.push([Markup.button.webApp('👀 View', `${base}?startapp=${startappParam}`)]);
    }
    try {
        await bot.telegram.sendMessage(targetTgId, text, Markup.inlineKeyboard(rows));
    } catch (err) {
        console.error(`Failed to send TG notification to ${targetTgId}:`, err.message);
        // Odd characters / emoji can make Telegram reject a message — retry once with plain safe text
        if (/can't parse|entities|emoji|Bad Request: message text/i.test(err.message || '')) {
            try {
                const plain = String(text).replace(/[^\p{L}\p{N}\p{P}\p{Z}\n]/gu, '').slice(0, 900);
                await bot.telegram.sendMessage(targetTgId, plain || 'You have a new notification', Markup.inlineKeyboard(rows));
            } catch (e2) { console.error('plain retry failed:', e2.message); }
        }
    }
}

// ================= Notify Owners (Resolves Channel Post Likes/Comments Notifications to Channel Owner) =================
async function notifyPostOwners(postAuthorId, postType, messageText, startappParam) {
    try {
        if (postType === 'channel') {
            const hit = (await getChannelMap()).get(String(postAuthorId));   // cached — no full users scan per like
            if (hit) sendTelegramNotification(hit.owner.tg_id, messageText, startappParam);
        } else {
            sendTelegramNotification(postAuthorId, messageText, startappParam);
        }
    } catch (err) {
        console.error("Notification forwarding failed:", err);
    }
}


// ================= In-app notifications (bell inside the app) =================
// Rows live in the "notifications" table (sql/11). Every helper is fire-and-forget and never
// throws, so a missing table can't break likes/comments. Old rows are pruned after 30 days.
const MILESTONES = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 50000];
let notifWarned = false;
const DEDUPE_TYPES = new Set(['like', 'reaction', 'share', 'follow', 'comment_like', 'views', 'referral']);

async function ownersOf(authorId, type) {
    if (type === 'channel') {
        const hit = (await getChannelMap()).get(String(authorId));
        return hit ? [String(hit.owner.tg_id)] : [];
    }
    return [String(authorId)];
}

// n = { type, actor:{id,name}|null, targetType:'post'|'video'|'profile', targetId, commentId, message }
async function pushNotif(userId, n) {
    try {
        userId = String(userId);
        const actorId = n.actor ? String(n.actor.id) : null;
        if (!userId || userId === actorId) return;
        if (DEDUPE_TYPES.has(n.type)) {
            let q = supabase.from('notifications').select('id').eq('user_id', userId).eq('type', n.type).eq('is_read', false).limit(1);
            q = actorId ? q.eq('actor_id', actorId) : q.is('actor_id', null);
            if (n.targetId) q = q.eq('target_id', String(n.targetId));
            if (n.message && n.type === 'views') q = q.eq('message', n.message);
            const { data: dup, error: dErr } = await q;
            if (dErr) throw dErr;
            if (dup && dup.length) return;
        }
        let photo = null, name = n.actor ? (n.actor.name || 'Someone') : null;
        if (actorId) {
            const meta = (await getUserMetaBatch([actorId]))[actorId];
            if (meta) { photo = meta.photo_url || null; name = meta.name || name; }
        }
        const { error } = await supabase.from('notifications').insert([{
            user_id: userId, type: n.type, actor_id: actorId, actor_name: name, actor_photo: photo,
            target_type: n.targetType || null, target_id: n.targetId ? String(n.targetId) : null,
            comment_id: n.commentId ? String(n.commentId) : null, message: n.message || null
        }]);
        if (error) throw error;
    } catch (e) {
        if (!notifWarned) { notifWarned = true; console.error('In-app notification skipped (run sql/11_notifications_and_username.sql?):', e.message || e); }
    }
}

// Notify whoever owns a post/video (the author, or the channel's owner)
function notifyInApp(authorId, authorType, n) {
    ownersOf(authorId, authorType).then(owners => owners.forEach(o => pushNotif(o, n))).catch(() => {});
}

app.post('/api/notifications', async (req, res) => {
    const tgUser = validateTGData(req.body.initData);
    if (!tgUser) return res.status(403).json({ error: "Unauthorized" });
    const me = tgUser.id.toString();
    try {
        const [list, unread] = await Promise.all([
            supabase.from('notifications').select('*').eq('user_id', me).order('created_at', { ascending: false }).limit(40),
            supabase.from('notifications').select('*', { count: 'exact', head: true }).eq('user_id', me).eq('is_read', false)
        ]);
        if (list.error) throw list.error;
        res.json({ items: list.data || [], unread: unread.count || 0 });
    } catch (e) { res.json({ items: [], unread: 0 }); }
});

app.post('/api/notifCount', async (req, res) => {
    const tgUser = validateTGData(req.body.initData);
    if (!tgUser) return res.status(403).json({ error: "Unauthorized" });
    try {
        const { count, error } = await supabase.from('notifications').select('*', { count: 'exact', head: true }).eq('user_id', tgUser.id.toString()).eq('is_read', false);
        res.json({ count: error ? 0 : (count || 0) });
    } catch (e) { res.json({ count: 0 }); }
});

app.post('/api/notifRead', async (req, res) => {
    const tgUser = validateTGData(req.body.initData);
    if (!tgUser) return res.status(403).json({ error: "Unauthorized" });
    try {
        let q = supabase.from('notifications').update({ is_read: true }).eq('user_id', tgUser.id.toString());
        if (req.body.id) q = q.eq('id', req.body.id); else q = q.eq('is_read', false);
        await q;
        res.json({ success: true });
    } catch (e) { res.json({ success: false }); }
});

app.post('/api/notifDelete', async (req, res) => {
    const tgUser = validateTGData(req.body.initData);
    if (!tgUser) return res.status(403).json({ error: "Unauthorized" });
    try {
        let q = supabase.from('notifications').delete().eq('user_id', tgUser.id.toString());
        if (req.body.id) q = q.eq('id', req.body.id);
        await q;
        res.json({ success: true });
    } catch (e) { res.json({ success: false }); }
});

// Share button pressed → tell the owner (the share itself happens inside Telegram)
app.post('/api/trackShare', async (req, res) => {
    const tgUser = validateTGData(req.body.initData);
    if (!tgUser) return res.status(403).json({ error: "Unauthorized" });
    const kind = req.body.contentType === 'video' ? 'video' : 'post';
    const id = String(req.body.id || '');
    res.json({ success: true });
    try {
        const { data: row } = await supabase.from(kind === 'video' ? 'videos' : 'posts').select('author_id, type').eq('id', id).maybeSingle();
        if (row) notifyInApp(row.author_id, row.type, { type: 'share', actor: { id: tgUser.id, name: tgUser.first_name }, targetType: kind, targetId: id, message: `shared your ${kind}` });
    } catch (e) { /* ignore */ }
});

setInterval(() => { supabase.from('notifications').delete().lt('created_at', new Date(Date.now() - 30 * 86400000).toISOString()).then(() => {}, () => {}); }, 6 * 3600 * 1000);

// ================= Auto Fetch Telegram Profile Photo =================
async function getTgProfilePic(tgId) {
    if (!isRealTgId(tgId)) return `https://ui-avatars.com/api/?background=random&name=${encodeURIComponent('G')}`;
    try {
        const photos = await bot.telegram.getUserProfilePhotos(tgId, 0, 1);
        if (photos.total_count > 0) {
            const sizes = photos.photos[0];
            const fileId = sizes[sizes.length - 1].file_id; // largest resolution
            return tgImageUrl(fileId);
        }
    } catch (e) { console.log("Photo fetch failed"); }
    return "https://ui-avatars.com/api/?name=User&background=random";
}

// ================= Self-healing user lookup =================
// Inserts a new user row, and if the DB schema is missing a column the payload references
// (PostgREST error PGRST204 — e.g. "Could not find the 'referred_by' column"), retries once
// with that field stripped out. This is a safety net for schema drift; the real fix is still
// to run fix_missing_referred_by_column.sql, which this will keep reminding you about.
async function insertUserRow(payload) {
    let { data, error } = await supabase.from('users').insert([payload]).select().single();
    if (error && error.code === 'PGRST204') {
        const match = error.message && error.message.match(/'([^']+)' column/);
        const missingCol = match ? match[1] : null;
        if (missingCol && missingCol in payload) {
            console.error(`insertUserRow: '${missingCol}' column is missing from the users table — please run fix_missing_referred_by_column.sql (or the matching migration) in Supabase. Retrying without it for now.`);
            const retryPayload = { ...payload };
            delete retryPayload[missingCol];
            const retry = await supabase.from('users').insert([retryPayload]).select().single();
            data = retry.data;
            error = retry.error;
        }
    }
    return { data, error };
}

// Several actions (add channel, create post, etc.) used to hard-fail with "user not found"
// if that person's /api/auth insert had failed earlier for any reason (a transient DB error,
// a since-fixed bug, etc.). Rather than leaving them permanently stuck, try once to (re)create
// their row here before giving up.
async function getOrCreateUser(tgUser) {
    const tgId = tgUser.id.toString();
    const { data: existing } = await supabase.from('users').select('*').eq('tg_id', tgId).maybeSingle();
    if (existing) return existing;

    console.warn(`getOrCreateUser: no row for ${tgId}, attempting to create one now.`);
    const photo_url = await getTgProfilePic(tgId);
    const { data: created, error: insertErr } = await insertUserRow({
        tg_id: tgId,
        name: [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ') || "User",
        username: tgUser.username || null,
        photo_url,
        referred_by: null,
        channels: [],
        is_verified: false,
        is_admin: false
    });

    if (insertErr) {
        console.error(`getOrCreateUser: failed to create user ${tgId}:`, insertErr);
        return null;
    }
    return created;
}

// ================= Maintenance Mode Helper =================
let maintenanceCache = { enabled: false, ts: 0 };
async function isMaintenanceMode() {
    // cache for 5s so we don't hit the DB on every single request
    if (Date.now() - maintenanceCache.ts < 5000) return maintenanceCache.enabled;
    try {
        const { data } = await supabase.from('app_settings').select('value').eq('key', 'maintenance_mode').maybeSingle();
        maintenanceCache = { enabled: data ? data.value === 'true' : false, ts: Date.now() };
    } catch (e) { maintenanceCache = { enabled: false, ts: Date.now() }; }
    return maintenanceCache.enabled;
}

// ================= Bot Commands =================
bot.start(async (ctx) => {
    const tgId = ctx.from.id.toString();
    const payload = ctx.startPayload || "";

    // Blocked / banned users can't re-register
    const { data: banned } = await supabase.from('banned_users').select('tg_id').eq('tg_id', tgId).maybeSingle();
    if (banned) {
        return ctx.reply('🚫 Your account has been banned from SnapPages.');
    }

    let { data: user } = await supabase.from('users').select('*').eq('tg_id', tgId).maybeSingle();

    if (!user) {
        const photo_url = await getTgProfilePic(tgId);
        let referred_by = null;
        if (extractRef(payload, tgId)) {
            referred_by = extractRef(payload, tgId);

            // Notify the inviter only on genuine brand new registration
            sendTelegramNotification(
                referred_by,
                `🎉 New Refer Joined!\n\n${ctx.from.first_name} has joined using your referral link. Check your Level Stats inside the Referral Center.`,
                "settings"
            );
        }

        const { error: startInsertErr } = await insertUserRow({
            tg_id: tgId,
            name: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || "Telegram User",
            username: ctx.from.username || null,
            photo_url,
            referred_by,
            channels: [],
            is_verified: false,
            is_admin: false
        });
        if (startInsertErr) {
            console.error("User insert failed in /start handler:", startInsertErr);
        }
    }
    ctx.reply(`👋 Hi ${ctx.from.first_name}! SnapPages — a Telegram-based social feed mini-app. Hope you enjoy using it!`, Markup.inlineKeyboard([ Markup.button.webApp('Open App', process.env.MINI_APP_URL) ]));
});

// ================= Channel Auto Sync =================
// ================= Channel-owner alert for every channel auto-post =================
async function notifyAdminsChannelContent(kind, id, channelTitle, text) {
    try {
        if (!id) return;
        // Recipients = the user(s) who added this channel to the Mini App (its owners)
        const table = kind === 'video' ? 'videos' : 'posts';
        const { data: row } = await supabase.from(table).select('author_id').eq('id', id).maybeSingle();
        if (!row) return;
        const { data: allUsers } = await supabase.from('users').select('tg_id, channels');
        const ids = new Set((allUsers || [])
            .filter(u => Array.isArray(u.channels) && u.channels.some(c => String(c.id) === String(row.author_id)))
            .map(u => String(u.tg_id)));
        if (ids.size === 0) return;
        const label = kind === 'video' ? '🎬 Video' : '📝 Post';
        const preview = (text || '').replace(/\s+/g, ' ').slice(0, 150);
        const msg = `📢 New channel ${label} auto-posted\nChannel: ${channelTitle || 'Unknown'}${preview ? `\n\n${preview}${(text || '').length > 150 ? '…' : ''}` : ''}`;
        const appUrl = `${process.env.MINI_APP_URL}?startapp=${kind === 'video' ? 'video_' : 'post_'}${id}`;
        // "style" (danger = red, primary = blue) is supported by newer Telegram clients;
        // older clients just show the buttons in the default colour.
        const reply_markup = { inline_keyboard: [
            [{ text: '🗑 Remove Post', callback_data: `rm:${kind}:${id}`, style: 'danger' }],
            [{ text: '🚀 Open App & View Post', web_app: { url: appUrl }, style: 'primary' }]
        ] };
        for (const adminId of ids) {
            try { await bot.telegram.sendMessage(adminId, msg, { reply_markup }); }
            catch (e) { console.error('Admin notify failed for', adminId, e.message); }
        }
    } catch (e) { console.error('notifyAdminsChannelContent failed:', e.message || e); }
}

// Remove Post button handler (the channel's owner, or an app admin)
bot.action(/^rm:(post|video):(.+)$/, async (ctx) => {
    try {
        const kind = ctx.match[1], id = ctx.match[2];
        const fromId = String(ctx.from.id);
        const table = kind === 'video' ? 'videos' : 'posts';
        const { data: item } = await supabase.from(table).select('author_id').eq('id', id).maybeSingle();
        if (!item) { await ctx.answerCbQuery('Already removed'); try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch (e) {} return; }
        const { data: u } = await supabase.from('users').select('is_admin, channels').eq('tg_id', fromId).maybeSingle();
        const ownsChannel = u && Array.isArray(u.channels) && u.channels.some(c => String(c.id) === String(item.author_id));
        if (!(ownsChannel || (u && u.is_admin))) return ctx.answerCbQuery('Not allowed', { show_alert: true });
        if (kind === 'video') {
            const { data: v } = await supabase.from('videos').select('*').eq('id', id).maybeSingle();
            if (v && v.owned_storage && v.storage_chat_id && v.storage_message_id) {
                try { await bot.telegram.deleteMessage(v.storage_chat_id, v.storage_message_id); } catch (e) {}
            }
            await supabase.from('videos').delete().eq('id', id);
        } else {
            await supabase.from('posts').delete().eq('id', id);
        }
        await supabase.from('reports').delete().eq('post_id', String(id)).eq('content_type', kind);
        await ctx.answerCbQuery('Removed from the app ✅');
        try { await ctx.editMessageText((ctx.callbackQuery.message.text || '') + '\n\n✅ Removed from the app', { reply_markup: { inline_keyboard: [] } }); } catch (e) {}
    } catch (e) {
        console.error('rm action failed:', e);
        try { await ctx.answerCbQuery('Failed to remove'); } catch (_) {}
    }
});

// Telegram sends a multi-photo channel post (an "album") as several separate channel_post
// updates that all share the same media_group_id, arriving within a fraction of a second of
// each other. We buffer them briefly and merge into a single post with all the images once
// no more arrive, rather than creating one post per photo.
const mediaGroupBuffers = {};
function bufferMediaGroupPhoto(groupId, { channelId, channelName, fileId, caption, entities }) {
    if (!mediaGroupBuffers[groupId]) {
        mediaGroupBuffers[groupId] = { channelId, channelName, fileIds: [], caption: '', entities: null, timer: null };
    }
    const buf = mediaGroupBuffers[groupId];
    buf.fileIds.push(fileId);
    // Telegram only attaches the caption to (usually) the first message in the album.
    if (caption) { buf.caption = caption; buf.entities = entities || null; }

    if (buf.timer) clearTimeout(buf.timer);
    buf.timer = setTimeout(async () => {
        delete mediaGroupBuffers[groupId];
        try {
            const { data: ins } = await supabase.from('posts').insert([{
                author_id: buf.channelId,
                author_name: buf.channelName,
                type: 'channel',
                text: buf.caption || '',
                entities: buf.entities,
                image_urls: buf.fileIds.map(id => tgImageUrl(id)),
                likes_count: 0,
                likes_users: [],
                is_pinned: false,
                created_at: new Date().toISOString()
            }]).select().single();
            await enforcePostCap();
            if (ins) notifyAdminsChannelContent('post', ins.id, buf.channelName, buf.caption);
        } catch (e) {
            console.error("Media group finalize failed:", e);
        }
    }, 1500); // Telegram delivers all of an album's updates within ~1s of each other
}

bot.on('channel_post', async (ctx) => {
    const channelId = ctx.update.channel_post.chat.id.toString();
    const msg = ctx.update.channel_post;

    // Ignore service updates (title/photo changed, pinned message, member changes, etc.) —
    // only actual text/photo/video content should ever become a post or Short.
    const isServiceUpdate = msg.new_chat_title || msg.new_chat_photo || msg.delete_chat_photo ||
        msg.pinned_message || msg.new_chat_members || msg.left_chat_member ||
        msg.migrate_to_chat_id || msg.migrate_from_chat_id || msg.group_chat_created ||
        msg.channel_chat_created || msg.message_auto_delete_timer_changed;
    if (isServiceUpdate) return;

    // Only these content types are synced — no documents, polls, stickers, voice notes, etc.
    const hasSupportedContent = (msg.text && !msg.photo && !msg.video) || msg.photo || msg.video;
    if (!hasSupportedContent) return;

    // Skip banned channels entirely
    const { data: bannedChannel } = await supabase.from('banned_channels').select('channel_id').eq('channel_id', channelId).maybeSingle();
    if (bannedChannel) return;

    const { data: users, error } = await supabase.from('users').select('tg_id, channels');
    if (error) return;

    let isRegistered = false;
    let registeredOwner = null;
    users?.forEach(u => {
        if (u.channels && Array.isArray(u.channels)) {
            if (u.channels.some(c => String(c.id) === String(channelId))) {
                isRegistered = true;
                registeredOwner = u;
            }
        }
    });

    // Self-heal stale cached channel info (e.g. it was private when added, is public now) —
    // Telegram includes the channel's current username/title on every channel_post.
    if (isRegistered && registeredOwner) {
        const freshUsername = msg.chat.username || 'private';
        const freshTitle = msg.chat.title;
        const current = registeredOwner.channels.find(c => String(c.id) === String(channelId));
        if (current && (current.username !== freshUsername || current.name !== freshTitle)) {
            const updatedChannels = registeredOwner.channels.map(c =>
                String(c.id) === String(channelId) ? { ...c, username: freshUsername, name: freshTitle || c.name } : c
            );
            await supabase.from('users').update({ channels: updatedChannels }).eq('tg_id', registeredOwner.tg_id);
        invalidateAuthorCaches();
        }
    }

    if (isRegistered) {
        try {
            // Videos go to the Shorts feed (videos table); everything else stays a regular post.
            if (msg.video) {
                // Enforce the same 18MB cap as user uploads — Telegram tells us the file size upfront.
                if (msg.video.file_size && msg.video.file_size > MAX_VIDEO_BYTES) {
                    console.warn(`Auto Sync: skipped video from ${channelId} — ${msg.video.file_size} bytes exceeds the ${MAX_VIDEO_BYTES} byte cap.`);
                    return;
                }
                const { data: insV } = await supabase.from('videos').insert([{
                    author_id: channelId,
                    author_name: msg.chat.title || 'Channel Post',
                    type: 'channel',
                    caption: msg.caption || '',
                    entities: msg.caption_entities || null,
                    file_id: msg.video.file_id,
                    storage_chat_id: channelId,
                    storage_message_id: msg.message_id,
                    owned_storage: false, // it's the channel's own message, we must never delete it
                    likes_count: 0,
                    likes_users: [],
                    created_at: new Date().toISOString()
                }]).select().single();
                await enforceVideoCap();
                if (insV) notifyAdminsChannelContent('video', insV.id, msg.chat.title, msg.caption);
                return;
            }

            // A multi-photo album: buffer this photo and merge with the rest of the album
            // (they arrive as separate updates sharing the same media_group_id) into one post.
            if (msg.photo && msg.media_group_id) {
                const fileId = msg.photo[msg.photo.length - 1].file_id;
                bufferMediaGroupPhoto(msg.media_group_id, {
                    channelId,
                    channelName: msg.chat.title || 'Channel Post',
                    fileId,
                    caption: msg.caption,
                    entities: msg.caption_entities
                });
                return;
            }

            let imageUrls = [];
            if (msg.photo) {
                // Already hosted on Telegram — just reference the file_id, no re-upload needed.
                const fileId = msg.photo[msg.photo.length - 1].file_id;
                imageUrls.push(tgImageUrl(fileId));
            }

            const textContent = msg.text || msg.caption || '';
            const entities = msg.entities || msg.caption_entities || null;

            const { data: insP } = await supabase.from('posts').insert([{
                author_id: channelId,
                author_name: msg.chat.title || 'Channel Post',
                type: 'channel',
                text: textContent,
                entities,
                image_urls: imageUrls,
                likes_count: 0,
                likes_users: [],
                is_pinned: false,
                created_at: new Date().toISOString()
            }]).select().single();

            await enforcePostCap();
            if (insP) notifyAdminsChannelContent('post', insP.id, msg.chat.title, textContent);
        } catch (e) {
            console.error("Auto Sync Sync Error", e);
        }
    }
});

// Keep only the most recent 500 posts (per the spec's storage cap)
async function enforcePostCap(cap = 2500) {
    try {
        const { count } = await supabase.from('posts').select('*', { count: 'exact', head: true });
        if (count && count > cap) {
            const excess = count - cap;
            const { data: oldest } = await supabase.from('posts').select('id').order('created_at', { ascending: true }).limit(excess);
            if (oldest && oldest.length > 0) {
                await supabase.from('posts').delete().in('id', oldest.map(p => p.id));
            }
        }
    } catch (e) { console.error("Post cap enforcement failed:", e); }
}

// Keep only the most recent 50 videos (per the spec's storage cap). Only deletes the
// Telegram message when we own the storage copy (user uploads) — never a channel's own post.
async function enforceVideoCap(cap = MAX_VIDEOS_IN_DB) {
    try {
        const { count } = await supabase.from('videos').select('*', { count: 'exact', head: true });
        if (count && count > cap) {
            const excess = count - cap;
            const { data: oldest } = await supabase.from('videos').select('id, storage_chat_id, storage_message_id, owned_storage').order('created_at', { ascending: true }).limit(excess);
            for (const v of (oldest || [])) {
                if (v.owned_storage && v.storage_chat_id && v.storage_message_id) {
                    try { await bot.telegram.deleteMessage(v.storage_chat_id, v.storage_message_id); } catch (delErr) { /* best effort */ }
                }
                await supabase.from('videos').delete().eq('id', v.id);
            }
        }
    } catch (e) { console.error("Video cap enforcement failed:", e); }
}

// ================= APIs =================

// ================= Support Link Helper =================
const DEFAULT_SUPPORT_LINK = "https://t.me/+lNYv0-1Y_Lo3NjVl";
let supportLinkCache = { link: null, ts: 0 };
async function getSupportLink() {
    if (Date.now() - supportLinkCache.ts < 5000 && supportLinkCache.link) return supportLinkCache.link;
    try {
        const { data } = await supabase.from('app_settings').select('value').eq('key', 'support_link').maybeSingle();
        supportLinkCache = { link: (data && data.value) ? data.value : DEFAULT_SUPPORT_LINK, ts: Date.now() };
    } catch (e) { supportLinkCache = { link: DEFAULT_SUPPORT_LINK, ts: Date.now() }; }
    return supportLinkCache.link;
}

// Public: lets the frontend know if the app is in maintenance mode before doing anything else,
// and hands over the current support link (admin-configurable).
app.get('/api/appStatus', async (req, res) => {
    const maintenance = await isMaintenanceMode();
    const supportLink = await getSupportLink();
    res.json({ maintenance, supportLink });
});

// Browser visitors get a throw-away guest account (rate-limited per IP to protect the free tier)
const guestLog = new Map();
app.post('/api/guestInit', (req, res) => {
    const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    const now = Date.now();
    const recent = (guestLog.get(ip) || []).filter(t => now - t < 3600 * 1000);
    if (recent.length >= 15) return res.status(429).json({ error: 'Too many new guests from this network, try again later' });
    recent.push(now); guestLog.set(ip, recent);
    if (guestLog.size > 5000) guestLog.delete(guestLog.keys().next().value);
    res.json({ token: makeGuestToken() });
});

app.post('/api/auth', async (req, res) => {
    const tgUser = validateTGData(req.body.initData);
    if (!tgUser) return res.status(403).json({ error: "Unauthorized" });

    const tgId = tgUser.id.toString();

    const { data: banned } = await supabase.from('banned_users').select('tg_id').eq('tg_id', tgId).maybeSingle();
    if (banned) return res.status(403).json({ error: "banned" });

    try {
        const urlParams = new URLSearchParams(req.body.initData);
        const startParam = urlParams.get('start_param') || '';

        let { data: user } = await supabase.from('users').select('*').eq('tg_id', tgId).maybeSingle();

        if (!user) {
            const photo_url = await getTgProfilePic(tgId);
            let referred_by = null;
            if (extractRef(startParam, tgId)) {
                referred_by = extractRef(startParam, tgId);

                sendTelegramNotification(
                    referred_by,
                    `🎉 New Refer Joined!\n\n${tgUser.first_name} has joined using your referral link. Check your Level Stats inside the Referral Center.`,
                    "settings"
                );
                pushNotif(referred_by, { type: 'referral', actor: { id: tgId, name: tgUser.first_name }, targetType: 'profile', targetId: tgId, message: 'joined using your invite link 🎉' });
            }

            const { data: newUser, error: insertErr } = await insertUserRow({
                tg_id: tgId,
                name: [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ') || "User",
                username: tgUser.username || null,
                photo_url,
                referred_by,
                channels: [],
                is_verified: false,
                is_admin: false
            });

            if (insertErr || !newUser) {
                console.error("User insert failed (check fix_missing_referred_by_column.sql / admin_panel_migration.sql have been run):", insertErr);
                return res.status(500).json({ error: `Failed to create user: ${insertErr ? insertErr.message : 'unknown error'}` });
            }
            user = newUser;
        } else if (!user.photo_url || user.photo_url.includes('ui-avatars')) {
            const photo_url = await getTgProfilePic(tgId);
            const { data: updated, error: updateErr } = await supabase.from('users').update({ photo_url }).eq('tg_id', tgId).select().single();
            if (!updateErr && updated) user = updated;
        }

        if (!user) {
            return res.status(500).json({ error: "User record could not be loaded" });
        }

        // Daily streak: +1 for each consecutive day the user opens the app (needs sql/07; silently skipped if columns are missing)
        try {
            const today = new Date().toISOString().slice(0, 10);
            if (user.last_active_date !== today && 'last_active_date' in user) {
                const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
                const streak = user.last_active_date === yesterday ? (user.streak_count || 0) + 1 : 1;
                const best = Math.max(user.best_streak || 0, streak);
                const { error: stErr } = await supabase.from('users').update({ streak_count: streak, best_streak: best, last_active_date: today }).eq('tg_id', tgId);
                if (!stErr) { user.streak_count = streak; user.best_streak = best; user.last_active_date = today; }
            }
        } catch (e) { /* streak is optional */ }

        const { count: refCount } = await supabase.from('users').select('*', { count: 'exact', head: true }).eq('referred_by', tgId);
        user.ref_count = refCount || 0;
        // Verified (blue badge) users are unlocked to the top level regardless of referrals
        user.level = user.is_verified ? 3 : getLevelData(refCount || 0).level;

        res.json({ success: true, user });
    } catch (e) {
        console.error("Auth route crashed:", e);
        res.status(500).json({ error: e.message || "Internal server error" });
    }
});

// Secure endpoint to get all Posts with Pagination and author data mapping
app.post('/api/getPosts', async (req, res) => {
    const page = Math.max(1, parseInt(req.body.page) || 1);
    const limit = Math.min(20, Math.max(1, parseInt(req.body.limit) || 10));   // hard cap keeps responses small
    const { feed, authorId, initData } = req.body;
    const offset = (page - 1) * limit;

    try {
        let followIds = null;
        if (feed === 'following') {
            const tgUser = validateTGData(initData);
            if (!tgUser) return res.json([]);
            followIds = await getFollowingIds(tgUser.id.toString());
            if (!followIds.length) return res.json([]);
        }
        const base = () => {
            let q = supabase.from('posts').select('*');
            if (followIds) q = q.in('author_id', followIds);
            if (authorId) q = q.eq('author_id', String(authorId));
            return q;
        };

        // Pinned posts only lead the main "For You" feed
        if (page === 1 && !followIds && !authorId) {
            const { data: pinned } = await supabase.from('posts').select('*').eq('is_pinned', true).order('created_at', { ascending: false });
            const { data: rest, error } = await base().eq('is_pinned', false).order('created_at', { ascending: false }).range(0, limit - 1);
            if (error) throw error;
            return res.json(await enrichPosts([...(pinned || []), ...(rest || [])]));
        }

        let q = base().order('created_at', { ascending: false }).range(offset, offset + limit - 1);
        if (!followIds && !authorId) q = base().eq('is_pinned', false).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
        const { data: posts, error } = await q;
        if (error) throw error;
        res.json(await enrichPosts(posts || []));
    } catch (e) {
        console.error("Feed error:", e);
        res.json([]);
    }
});

// ================= Edit own profile (display name + @username) =================
app.post('/api/setNotify', async (req, res) => {
    const tgUser = validateTGData(req.body.initData);
    if (!tgUser) return res.status(403).json({ error: "Unauthorized" });
    const on = !!req.body.enabled;
    const { error } = await supabase.from('users').update({ notify_enabled: on }).eq('tg_id', tgUser.id.toString());
    if (error) return res.status(500).json({ error: "Run sql/12_settings_ads_premium.sql in Supabase first" });
    notifyPrefCache.set(tgUser.id.toString(), { on, ts: Date.now() });
    res.json({ success: true, enabled: on });
});

app.post('/api/setProfile', async (req, res) => {
    const tgUser = validateTGData(req.body.initData);
    if (!tgUser) return res.status(403).json({ error: "Unauthorized" });
    const me = tgUser.id.toString();
    const name = String(req.body.name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40);
    const handle = String(req.body.username || '').trim().replace(/^@/, '');
    if (!name) return res.status(400).json({ error: "Name can't be empty" });
    if (handle && !/^[A-Za-z][A-Za-z0-9_]{3,19}$/.test(handle)) {
        return res.status(400).json({ error: "Username: 4–20 letters, numbers or _ , starting with a letter" });
    }
    try {
        if (handle) {
            const [a, b] = await Promise.all([
                supabase.from('users').select('tg_id').ilike('app_username', handle).neq('tg_id', me).limit(1),
                supabase.from('users').select('tg_id').ilike('username', handle).neq('tg_id', me).limit(1)
            ]);
            if (a.error) return res.status(500).json({ error: "Username feature isn't set up yet — run sql/11_notifications_and_username.sql in Supabase" });
            if ((a.data && a.data.length) || (b.data && b.data.length)) return res.status(409).json({ error: "That username is already taken" });
        }
        const patch = { name, app_username: handle || null };
        if (req.body.photoBase64) {
            if (String(req.body.photoBase64).length > 4 * 1024 * 1024) return res.status(400).json({ error: "Photo is too large" });
            const url = await uploadImageToTelegram(req.body.photoBase64);
            if (!url) return res.status(500).json({ error: "Photo upload failed — storage channel isn't set (Admin panel → Storage Channel)" });
            patch.photo_url = url;
        }
        const { error } = await supabase.from('users').update(patch).eq('tg_id', me);
        if (error) throw error;
        invalidateAuthorCaches();
        res.json({ success: true, name, username: handle, photo: patch.photo_url || null });
    } catch (e) {
        console.error('setProfile error:', e);
        res.status(500).json({ error: e.message || String(e) });
    }
});

// ================= Follow system + profiles =================
async function getFollowingIds(tgId) {
    const { data } = await supabase.from('snap_follows').select('followee_id').eq('follower_id', tgId).limit(1000);
    return (data || []).map(r => String(r.followee_id));
}

function followErr(e) {
    const m = String((e && (e.message || e.code)) || e);
    return /snap_follows|PGRST205|42P01/.test(m)
        ? "Follow system isn't set up yet — run sql/06_social_migration.sql in Supabase"
        : m;
}

// Who owns a followee? (a user is their own owner; a channel's owners are the users who added it)
async function resolveFollowee(targetId) {
    const { data: u } = await supabase.from('users').select('tg_id, name, username, photo_url, is_verified').eq('tg_id', targetId).maybeSingle();
    if (u) return { type: 'user', owners: [String(u.tg_id)], name: u.name, username: u.username, photo: u.photo_url, verified: !!u.is_verified, ownerVerified: !!u.is_verified, ownerId: String(u.tg_id) };
    const hit = (await getChannelMap()).get(String(targetId));
    if (hit) return { type: 'channel', owners: [String(hit.owner.tg_id)], name: hit.ch.title || hit.ch.name || 'Channel', username: hit.ch.username || '', photo: hit.ch.photo || '', verified: !!hit.ch.verified || hit.owner.is_verified, ownerVerified: hit.owner.is_verified, ownerId: String(hit.owner.tg_id) };
    return null;
}

app.post('/api/toggleFollow', async (req, res) => {
    const { initData, targetId } = req.body;
    const tgUser = validateTGData(initData);
    if (!tgUser) return res.status(403).json({ error: "Unauthorized" });
    const me = tgUser.id.toString();
    const target = String(targetId || '');
    if (!target) return res.status(400).json({ error: "Missing target" });
    try {
        const info = await resolveFollowee(target);
        if (!info) return res.status(404).json({ error: "Profile not found" });
        if (info.owners.includes(me)) return res.status(400).json({ error: "You can't follow yourself" });

        const { data: existing } = await supabase.from('snap_follows').select('follower_id').eq('follower_id', me).eq('followee_id', target).maybeSingle();
        let following;
        if (existing) {
            const { error } = await supabase.from('snap_follows').delete().eq('follower_id', me).eq('followee_id', target);
            if (error) throw error;
            following = false;
        } else {
            const { error } = await supabase.from('snap_follows').insert([{ follower_id: me, followee_id: target, followee_type: info.type }]);
            if (error) throw error;
            following = true;
            const who = tgUser.first_name || 'Someone';
            info.owners.forEach(o => sendTelegramNotification(o, `👤 ${who} started following ${info.type === 'channel' ? info.name : 'you'}!`, `profile_${me}`));
            info.owners.forEach(o => pushNotif(o, { type: 'follow', actor: { id: me, name: who }, targetType: 'profile', targetId: me, message: `started following ${info.type === 'channel' ? info.name : 'you'}` }));
        }
        const { count } = await supabase.from('snap_follows').select('*', { count: 'exact', head: true }).eq('followee_id', target);
        res.json({ success: true, following, followers: count || 0 });
    } catch (e) {
        console.error('follow error:', e); res.status(500).json({ error: followErr(e) });
    }
});

app.post('/api/getProfile', async (req, res) => {
    const { initData, authorId } = req.body;
    const tgUser = validateTGData(initData);
    if (!tgUser) return res.status(403).json({ error: "Unauthorized" });
    const me = tgUser.id.toString();
    const target = String(authorId || '');
    try {
        const info = await resolveFollowee(target);
        if (!info) return res.status(404).json({ error: "Profile not found" });
        let handle = '';
        if (info.type === 'user') { const h = await supabase.from('users').select('app_username').eq('tg_id', target).maybeSingle(); handle = (h.data && h.data.app_username) || ''; }
        const [followers, following, posts, mine, reels] = await Promise.all([
            supabase.from('snap_follows').select('*', { count: 'exact', head: true }).eq('followee_id', target),
            info.type === 'user' ? supabase.from('snap_follows').select('*', { count: 'exact', head: true }).eq('follower_id', target) : Promise.resolve({ count: 0 }),
            supabase.from('posts').select('*', { count: 'exact', head: true }).eq('author_id', target),
            supabase.from('snap_follows').select('follower_id').eq('follower_id', me).eq('followee_id', target).maybeSingle(),
            supabase.from('videos').select('*', { count: 'exact', head: true }).eq('author_id', target)
        ]);
        if (followers.error && /snap_follows|PGRST205|42P01/.test(String(followers.error.message || followers.error.code))) console.error('snap_follows table missing — run sql/06_social_migration.sql');
        res.json({
            id: target,
            type: info.type,
            name: info.name,
            username: info.username || '',
            handle,
            founder: String(info.id || target) === FOUNDER_ID,
            photo: info.photo || `https://ui-avatars.com/api/?name=${encodeURIComponent(info.name || 'U')}`,
            verified: info.verified,
            level: await getUserLevelCached(info.ownerId, info.ownerVerified),
            followers: followers.count || 0,
            following: following.count || 0,
            posts: posts.count || 0,
            reels: reels.count || 0,
            isFollowing: !!(mine && mine.data),
            isSelf: info.owners.includes(me)
        });
    } catch (e) {
        console.error('follow error:', e); res.status(500).json({ error: followErr(e) });
    }
});

// ================= Free-tier friendly author lookup =================
// Supabase free: 500MB DB, limited egress / connections.  Render free: 512MB RAM, sleeps when idle.
// So the feed must NOT do per-post queries. Everything below is batched and cached in memory.
const TTL = { channels: 30 * 1000, meta: 60 * 1000, level: 5 * 60 * 1000 };
let channelMapCache = { exp: 0, map: new Map() };
const userMetaCache = new Map();   // tg_id -> { exp, v }
const userLevelCache = new Map();  // tg_id -> { exp, v }

function invalidateAuthorCaches() {
    channelMapCache.exp = 0;
    userMetaCache.clear();
}

// channelId -> { ch, owner:{tg_id,is_verified} }  — one query per 30s instead of one per request
async function getChannelMap() {
    if (channelMapCache.exp > Date.now()) return channelMapCache.map;
    const { data } = await supabase.from('users').select('tg_id, channels, is_verified').not('channels', 'is', null);
    const map = new Map();
    (data || []).forEach(owner => {
        (owner.channels || []).forEach(ch => map.set(String(ch.id), { ch, owner: { tg_id: owner.tg_id, is_verified: !!owner.is_verified } }));
    });
    channelMapCache = { exp: Date.now() + TTL.channels, map };
    return map;
}

async function getUserMetaBatch(ids) {
    const out = {};
    const missing = [];
    ids.forEach(id => {
        const hit = userMetaCache.get(id);
        if (hit && hit.exp > Date.now()) out[id] = hit.v; else missing.push(id);
    });
    if (missing.length) {
        let { data, error } = await supabase.from('users').select('tg_id, photo_url, username, is_verified, name, app_username').in('tg_id', missing);
        if (error) ({ data } = await supabase.from('users').select('tg_id, photo_url, username, is_verified, name').in('tg_id', missing));   // sql/11 not run yet
        (data || []).forEach(u => {
            out[u.tg_id] = u;
            userMetaCache.set(u.tg_id, { exp: Date.now() + TTL.meta, v: u });
        });
    }
    return out;
}

async function getUserLevelCached(tgId, isVerified) {
    if (isVerified) return 3;
    const hit = userLevelCache.get(tgId);
    if (hit && hit.exp > Date.now()) return hit.v;
    const { count } = await supabase.from('users').select('*', { count: 'exact', head: true }).eq('referred_by', tgId);
    const level = getLevelData(count || 0).level;
    userLevelCache.set(tgId, { exp: Date.now() + TTL.level, v: level });
    if (userLevelCache.size > 5000) userLevelCache.delete(userLevelCache.keys().next().value);
    return level;
}

// Adds author_photo / author_level / author_username / author_verified to posts or videos
async function enrichAuthors(items) {
    if (!items || !items.length) return [];
    const channelMap = await getChannelMap();
    const userIds = [...new Set(items.filter(i => i.type === 'user').map(i => String(i.author_id)))];
    const metas = userIds.length ? await getUserMetaBatch(userIds) : {};
    const levels = {};
    await Promise.all(userIds.map(async id => { levels[id] = await getUserLevelCached(id, !!(metas[id] && metas[id].is_verified)); }));
    const ownerLevels = {};

    return Promise.all(items.map(async item => {
        let photo = `https://ui-avatars.com/api/?name=${encodeURIComponent(item.author_name || 'U')}`;
        let level = 1, username = '', verified = false, liveName = null;
        if (item.type === 'user') {
            const u = metas[String(item.author_id)];
            if (u) { if (u.photo_url) photo = u.photo_url; username = u.app_username || u.username || ''; verified = !!u.is_verified; if (u.name) liveName = u.name; }
            level = levels[String(item.author_id)] || 1;
        } else if (item.type === 'channel') {
            const hit = channelMap.get(String(item.author_id));
            if (hit) {
                if (hit.ch.photo) photo = hit.ch.photo;
                if (hit.ch.username) username = hit.ch.username;
                // A channel inherits its owner's badge AND referral level
                verified = !!hit.ch.verified || hit.owner.is_verified;
                const oid = String(hit.owner.tg_id);
                if (ownerLevels[oid] === undefined) ownerLevels[oid] = await getUserLevelCached(oid, hit.owner.is_verified);
                level = ownerLevels[oid];
            }
        }
        return { ...item, ...(liveName ? { author_name: liveName } : {}), author_photo: photo, author_level: level, author_username: username, author_verified: verified || String(item.author_id) === FOUNDER_ID, author_founder: item.type === 'user' && String(item.author_id) === FOUNDER_ID };
    }));
}

async function enrichPosts(posts) { return enrichAuthors(posts); }

// Secure endpoint to get User's Personal Posts (RLS Bypass)
app.post('/api/getMyPosts', async (req, res) => {
    const { initData } = req.body;
    const tgUser = validateTGData(initData);
    if (!tgUser) return res.status(403).json({ error: "Unauthorized" });

    try {
        const { data: posts, error } = await supabase.from('posts').select('*').eq('author_id', tgUser.id.toString()).order('created_at', { ascending: false });
        if (error) throw error;
        res.json(posts || []);
    } catch(e) {
        res.status(500).json({ error: e.message || e });
    }
});

// Secure Referral Stats calculation endpoint (RLS Bypass)
app.post('/api/getReferStats', async (req, res) => {
    const { initData } = req.body;
    const tgUser = validateTGData(initData);
    if (!tgUser) return res.status(403).json({ error: "Unauthorized" });

    try {
        const myId = tgUser.id.toString();

        // Level 1
        const { data: level1Users, error: err1 } = await supabase.from('users').select('*').eq('referred_by', myId);
        if (err1) throw err1;
        const l1Ids = (level1Users || []).map(u => u.tg_id);

        // Level 2
        let level2Users = [];
        if (l1Ids.length > 0) {
            const { data: l2, error: err2 } = await supabase.from('users').select('*').in('referred_by', l1Ids);
            if (err2) throw err2;
            level2Users = l2 || [];
        }
        const l2Ids = level2Users.map(u => u.tg_id);

        // Level 3
        let level3Users = [];
        if (l2Ids.length > 0) {
            const { data: l3, error: err3 } = await supabase.from('users').select('*').in('referred_by', l2Ids);
            if (err3) throw err3;
            level3Users = l3 || [];
        }

        res.json({
            level1: level1Users,
            level2: level2Users,
            level3: level3Users
        });
    } catch (e) {
        res.status(500).json({ error: e.message || e });
    }
});

// Create Post (images hosted directly on Telegram; RLS Bypass)
app.post('/api/createPost', async (req, res) => {
    const { initData, text, imagesBase64 } = req.body;
    const tgUser = validateTGData(initData);
    if (!tgUser) return res.status(403).json({ error: "Unauthorized" });

    try {
        const user = await getOrCreateUser(tgUser);
        if (!user) return res.status(404).json({ error: "Could not create your user record. Please check Render logs for details." });

        const { count: refCount } = await supabase.from('users').select('*', { count: 'exact', head: true }).eq('referred_by', tgUser.id.toString());
        const level = user.is_verified ? 3 : getLevelData(refCount || 0).level;

        let imageUrls = [];
        let uploadFailures = 0;
        if (imagesBase64 && imagesBase64.length > 0) {
            const results = await Promise.all(imagesBase64.slice(0, 4).map(img => uploadImageToTelegram(img)));   // parallel = faster posting
            results.forEach(u => u ? imageUrls.push(u) : uploadFailures++);
            if (uploadFailures > 0 && imageUrls.length === 0 && !String(text || '').trim()) {
                return res.status(500).json({ error: "Photo upload failed — the storage channel isn't working. Admin: Admin panel → Storage Channel." });
            }
        }

        const { error } = await supabase.from('posts').insert([{
            author_id: tgUser.id.toString(),
            author_name: user.name,
            type: 'user',
            text,
            image_urls: imageUrls,
            likes_count: 0,
            likes_users: [],
            is_pinned: false,
            created_at: new Date().toISOString()
        }]);

        if (error) throw error;
        await enforcePostCap();

        const response = { success: true };
        if (uploadFailures > 0) {
            console.error(`createPost: ${uploadFailures} image(s) failed to upload — check STORAGE_CHANNEL_ID is set and the bot is an admin there.`);
            response.warning = `Post created, but ${uploadFailures} image(s) failed to upload. Ask the admin to check the storage channel setup.`;
        }
        res.json(response);
    } catch (e) {
        res.status(500).json({ error: e.message || e });
    }
});

// Edit Post (Using Admin Key bypass with Ownership validation for Channel/User ownership)
app.post('/api/editPost', async (req, res) => {
    const { initData, postId, text, imageUrls } = req.body;
    const tgUser = validateTGData(initData);
    if (!tgUser) return res.status(403).json({ error: "Unauthorized" });

    try {
        const { data: post, error: findError } = await supabase.from('posts').select('*').eq('id', postId).maybeSingle();
        if (!post || findError) return res.status(404).json({ error: "Post not found" });

        const { data: user } = await supabase.from('users').select('*').eq('tg_id', tgUser.id.toString()).maybeSingle();
        if (!user) return res.status(403).json({ error: "Unauthorized" });

        let isOwner = false;
        if (post.type === 'channel') {
            isOwner = user.channels && Array.isArray(user.channels) &&
                      user.channels.some(c => String(c.id) === String(post.author_id));
        } else {
            isOwner = String(post.author_id) === String(user.tg_id);
        }

        if (!isOwner) return res.status(403).json({ error: "You do not own this post!" });

        // imageUrls can be a mix of already-hosted URLs (kept as-is) and newly-picked images
        // that arrive as raw base64 data URIs — those still need to be uploaded.
        let finalImageUrls = [];
        let uploadFailures = 0;
        for (const entry of (imageUrls || [])) {
            if (typeof entry === 'string' && entry.startsWith('data:')) {
                const uploadedUrl = await uploadImageToTelegram(entry);
                if (uploadedUrl) finalImageUrls.push(uploadedUrl);
                else uploadFailures++;
            } else if (entry) {
                finalImageUrls.push(entry); // already a hosted URL — keep it
            }
        }

        const { error } = await supabase.from('posts').update({
            text,
            image_urls: finalImageUrls
        }).eq('id', postId);

        if (error) throw error;

        const response = { success: true };
        if (uploadFailures > 0) {
            response.warning = `Post updated, but ${uploadFailures} new image(s) failed to upload.`;
        }
        res.json(response);
    } catch (e) {
        res.status(500).json({ error: e.message || e });
    }
});

// Delete Post (Using Admin Key bypass with Ownership validation for Channel/User ownership)
app.post('/api/deletePost', async (req, res) => {
    const { initData, postId } = req.body;
    const tgUser = validateTGData(initData);
    if (!tgUser) return res.status(403).json({ error: "Unauthorized" });

    try {
        const { data: post, error: findError } = await supabase.from('posts').select('*').eq('id', postId).maybeSingle();
        if (!post || findError) return res.status(404).json({ error: "Post not found" });

        const { data: user } = await supabase.from('users').select('*').eq('tg_id', tgUser.id.toString()).maybeSingle();
        if (!user) return res.status(403).json({ error: "Unauthorized" });

        let isOwner = false;
        if (post.type === 'channel') {
            isOwner = user.channels && Array.isArray(user.channels) &&
                      user.channels.some(c => String(c.id) === String(post.author_id));
        } else {
            isOwner = String(post.author_id) === String(user.tg_id);
        }

        if (!isOwner) return res.status(403).json({ error: "You do not own this post!" });

        const { error } = await supabase.from('posts').delete().eq('id', postId);
        if (error) throw error;
        await supabase.from('reports').delete().eq('post_id', postId).eq('content_type', 'post');
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message || e });
    }
});

// Like/Unlike dynamic handler with bot notifications (Forwarding to Channel Owners if liked)
app.post('/api/likePost', async (req, res) => {
    const { initData, postId } = req.body;
    const tgUser = validateTGData(initData);
    if (!tgUser) return res.status(403).json({ error: "Unauthorized" });

    try {
        const { data: post, error: fetchErr } = await supabase.from('posts').select('*').eq('id', postId).maybeSingle();
        if (fetchErr) throw fetchErr;

        if (post) {
            let likesUsers = post.likes_users || [];
            let likesCount = post.likes_count || 0;
            const userId = tgUser.id.toString();

            let hasLiked = false;
            if (likesUsers.includes(userId)) {
                likesUsers = likesUsers.filter(id => id !== userId);
                likesCount = Math.max(0, likesCount - 1);
            } else {
                likesUsers.push(userId);
                likesCount += 1;
                hasLiked = true;

                // Send Bot Notification to the post owner or channel owner
                const postPreview = post.text ? post.text.substring(0, 30) : 'Photo Post';
                await notifyPostOwners(
                    post.author_id,
                    post.type,
                    `❤️ ${tgUser.first_name} liked your post:\n"${postPreview}..."`,
                    `post_${postId}`
                );
                notifyInApp(post.author_id, post.type, { type: 'like', actor: { id: userId, name: tgUser.first_name }, targetType: 'post', targetId: postId, message: 'liked your post' });
            }

            // Hearting replaces any other reaction this user had on the post
            const upd = { likes_count: likesCount, likes_users: likesUsers };
            let reactions = post.reactions || {};
            if (hasLiked && reactions[userId]) { reactions = { ...reactions }; delete reactions[userId]; upd.reactions = reactions; }
            const { error: updateErr } = await supabase.from('posts').update(upd).eq('id', postId);
            if (updateErr) throw updateErr;

            res.json({ success: true, likesCount: likesCount + Object.keys(reactions).length, hasLiked, hearts: likesCount, reactions });
        } else {
            res.status(404).json({ error: "Post not found" });
        }
    } catch (e) {
        res.status(500).json({ error: e.message || e });
    }
});

// Insert a report row. Tolerates older "reports" tables (missing content_type column) and always
// stores ids as text, so posts (uuid) and videos (number) both work.
async function insertReportRow(row) {
    let { error } = await supabase.from('reports').insert([row]);
    if (error && /content_type/i.test(error.message || '')) {
        const { content_type, ...legacy } = row;
        ({ error } = await supabase.from('reports').insert([legacy]));
    }
    return error;
}

// ================= View counts =================
// The client batches the ids of posts/videos that were on screen for a moment and sends them every few seconds.
// bump_views() (sql/09) increments them in ONE query, so this stays cheap on the free database.
const viewRate = new Map();
app.post('/api/trackViews', async (req, res) => {
    const tgUser = validateTGData(req.body.initData);
    if (!tgUser) return res.status(403).json({ error: "Unauthorized" });
    const uid = tgUser.id.toString();
    const now = Date.now();
    const recent = (viewRate.get(uid) || []).filter(t => now - t < 60000);
    if (recent.length >= 20) return res.json({ success: true, skipped: true });
    recent.push(now); viewRate.set(uid, recent);
    if (viewRate.size > 20000) viewRate.delete(viewRate.keys().next().value);
    const clean = (arr) => [...new Set((Array.isArray(arr) ? arr : []).map(String))].filter(x => /^[A-Za-z0-9-]{1,40}$/.test(x)).slice(0, 30);
    try {
        const posts = clean(req.body.posts), videos = clean(req.body.videos);
        if (posts.length) await supabase.rpc('bump_views', { tbl: 'posts', ids: posts });
        if (videos.length) await supabase.rpc('bump_views', { tbl: 'videos', ids: videos });
        res.json({ success: true });
        // Milestone notifications (10, 25, 50, 100 ... views) — one cheap query, only rows exactly on a milestone come back
        for (const [tbl, ids, kind] of [['posts', posts, 'post'], ['videos', videos, 'video']]) {
            if (!ids.length) continue;
            const { data: hit } = await supabase.from(tbl).select('id, author_id, type, views').in('id', ids).in('views', MILESTONES);
            (hit || []).forEach(r => notifyInApp(r.author_id, r.type, { type: 'views', actor: null, targetType: kind, targetId: r.id, message: `Your ${kind} reached ${r.views} views 🎉` }));
        }
    } catch (e) { res.json({ success: false }); }
});

// ================= Reactions (long-press the Like button) =================
// ❤️ is the classic like (likes_users). Every other emoji is stored in the "reactions" JSON column as
// { userId: emoji } — one reaction per person, and picking one replaces a previous like/reaction.
const REACTION_EMOJIS = ['😂', '😮', '😢', '🔥', '👍'];
app.post('/api/react', async (req, res) => {
    const { initData, contentType = 'post', id, emoji } = req.body;
    const tgUser = validateTGData(initData);
    if (!tgUser) return res.status(403).json({ error: "Unauthorized" });
    if (!REACTION_EMOJIS.includes(emoji)) return res.status(400).json({ error: "Unknown reaction" });
    try {
        const table = contentType === 'video' ? 'videos' : 'posts';
        const { data: row, error } = await supabase.from(table).select('*').eq('id', id).maybeSingle();
        if (error || !row) return res.status(404).json({ error: "Not found" });
        if (!('reactions' in row)) return res.status(500).json({ error: "Reactions need a database update: run sql/08_reactions_and_replies.sql in Supabase, then try again." });

        const uid = tgUser.id.toString();
        const reactions = { ...(row.reactions || {}) };
        let likesUsers = row.likes_users || [];
        let likesCount = row.likes_count || 0;
        let myReaction = null;

        if (reactions[uid] === emoji) {
            delete reactions[uid];
        } else {
            const isNew = !reactions[uid];
            reactions[uid] = emoji;
            myReaction = emoji;
            if (likesUsers.includes(uid)) { likesUsers = likesUsers.filter(x => x !== uid); likesCount = Math.max(0, likesCount - 1); }
            if (isNew && String(row.author_id) !== uid) {
                const kind = contentType === 'video' ? 'video' : 'post';
                const preview = (contentType === 'video' ? row.caption : row.text) || (kind === 'video' ? 'Video' : 'Photo');
                notifyPostOwners(row.author_id, row.type, `${emoji} ${tgUser.first_name} reacted to your ${kind}:\n"${String(preview).substring(0, 30)}..."`, `${kind}_${id}`);
                notifyInApp(row.author_id, row.type, { type: 'reaction', actor: { id: uid, name: tgUser.first_name }, targetType: kind, targetId: id, message: `reacted ${emoji} to your ${kind}` });
            }
        }
        const { error: updErr } = await supabase.from(table).update({ reactions, likes_users: likesUsers, likes_count: likesCount }).eq('id', id);
        if (updErr) throw updErr;
        res.json({ success: true, likesCount: likesCount + Object.keys(reactions).length, myReaction, hasLiked: likesUsers.includes(uid), hearts: likesCount, reactions });
    } catch (e) {
        res.status(500).json({ error: e.message || e });
    }
});

// Report a post (feeds the Admin Panel's Post & User Manage tab)
app.post('/api/reportPost', async (req, res) => {
    const { initData, postId, reason } = req.body;
    const tgUser = validateTGData(initData);
    if (!tgUser) return res.status(403).json({ error: "Unauthorized" });

    try {
        const { data: post } = await supabase.from('posts').select('id, author_id, type').eq('id', postId).maybeSingle();
        if (!post) return res.status(404).json({ error: "Post not found" });

        const error = await insertReportRow({
            post_id: String(postId),
            post_author_id: String(post.author_id),
            post_type: post.type,
            content_type: 'post',
            reporter_id: tgUser.id.toString(),
            reason: reason || 'Not specified',
            created_at: new Date().toISOString()
        });
        if (error) { console.error('Report insert failed:', error.message); throw error; }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message || e });
    }
});

// Setup Channel
app.post('/api/addChannel', async (req, res) => {
    const { initData, channelInput } = req.body;
    const tgUser = validateTGData(initData);
    if (!tgUser) return res.status(403).json({ error: "Unauthorized" });

    try {
        let input = channelInput.trim();
        let chatId;

        // Resolve chat identifier based on type of input
        if (input.includes('t.me/')) {
            if (input.includes('/c/')) {
                const match = input.match(/\/c\/(\d+)/);
                if (match) {
                    chatId = `-100${match[1]}`; // Private channel message link parser
                }
            } else {
                const parts = input.split('t.me/');
                const path = parts[parts.length - 1].split('/')[0];
                if (path.startsWith('+')) {
                    return res.json({ error: "Private invite links are not supported directly. Please provide the numerical Channel ID (e.g. -100...) or make the channel public." });
                }
                chatId = `@${path.replace('@', '')}`;
            }
        } else if (/^-?\d+$/.test(input)) {
            // Numeric Channel ID — accept it whether or not the -100 prefix is included,
            // since many Telegram tools show only the bare digits (e.g. "1234567890"
            // instead of "-1001234567890").
            if (/^-100\d+$/.test(input)) {
                chatId = input;
            } else if (input.startsWith('-')) {
                chatId = input; // some other valid negative chat id (e.g. a basic group)
            } else {
                chatId = `-100${input}`;
            }
        } else {
            chatId = `@${input.replace('@', '')}`; // Standard public handle
        }

        const chat = await bot.telegram.getChat(chatId);

        // Refuse banned channels
        const { data: bannedChannel } = await supabase.from('banned_channels').select('channel_id').eq('channel_id', chat.id.toString()).maybeSingle();
        if (bannedChannel) {
            return res.json({ error: "This channel has been banned from SnapPages." });
        }

        // Verification: Check if Bot is Admin
        const botInfo = await bot.telegram.getMe();
        const member = await bot.telegram.getChatMember(chat.id, botInfo.id);
        if (member.status !== 'administrator') {
            return res.json({ error: "Bot is not an admin inside this channel!" });
        }

        // Query dynamic refer count to check Limit eligibility
        const { count: refs } = await supabase.from('users').select('*', { count: 'exact', head: true }).eq('referred_by', tgUser.id.toString());
        const { data: meRow } = await supabase.from('users').select('is_verified').eq('tg_id', tgUser.id.toString()).maybeSingle();
        const limits = (meRow && meRow.is_verified) ? { channels: 5 } : getLevelData(refs || 0);

        const user = await getOrCreateUser(tgUser);
        if (!user) {
            return res.json({ error: "Could not create your user record. Please check Render logs for details." });
        }
        let channels = user.channels || [];
        if (channels.length >= limits.channels) {
            return res.json({ error: `At your Level, you can only set up to ${limits.channels} channel(s).` });
        }

        let photoUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(chat.title || 'C')}`;
        if (chat.photo) {
            photoUrl = tgImageUrl(chat.photo.small_file_id);
        }

        const cleanUsername = chat.username || 'private';
        channels.push({ id: chat.id.toString(), name: chat.title, username: cleanUsername, photo: photoUrl, verified: false });
        await supabase.from('users').update({ channels }).eq('tg_id', tgUser.id.toString());
        invalidateAuthorCaches();

        // Send Bot notification for channel registration success
        sendTelegramNotification(
            tgUser.id.toString(),
            `📢 Auto-posting Channel successfully connected!\n\nChannel: ${chat.title} (@${cleanUsername})`,
            "settings"
        );

        res.json({ success: true, channels });

    } catch (e) {
        res.json({ error: `Verification Failed: ${e.message || e}. Ensure the Bot is Admin in your channel first.` });
    }
});

app.post('/api/removeChannel', async (req, res) => {
    const { initData, channelId } = req.body;
    const tgUser = validateTGData(initData);
    if (!tgUser) return res.status(403).json({ error: "Unauthorized" });
    try {
        const { data: user, error } = await supabase.from('users').select('channels').eq('tg_id', tgUser.id.toString()).maybeSingle();
        if (error || !user) return res.status(404).json({ error: "User not found" });
        let channels = (user.channels || []).filter(c => c.id !== channelId);
        await supabase.from('users').update({ channels }).eq('tg_id', tgUser.id.toString());
        invalidateAuthorCaches();
        res.json({ success: true, channels });
    } catch (e) {
        res.status(500).json({ error: e.message || e });
    }
});

// Secure Search Posts API (Bypassing direct client-side RLS Blockage)
// Trending hashtags: scans the latest posts once every 10 minutes (one cheap query), cached in memory
let trendingCache = { exp: 0, tags: [] };
app.get('/api/trendingTags', async (req, res) => {
    try {
        if (trendingCache.exp < Date.now()) {
            const { data } = await supabase.from('posts').select('text').order('created_at', { ascending: false }).limit(300);
            const counts = {};
            (data || []).forEach(p => {
                const seen = new Set((String(p.text || '').match(/#[\p{L}\p{M}\p{N}_]{2,30}/gu) || []).map(t => t.toLowerCase()));
                seen.forEach(t => { counts[t] = (counts[t] || 0) + 1; });
            });
            const tags = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([tag, count]) => ({ tag, count }));
            trendingCache = { exp: Date.now() + 10 * 60 * 1000, tags };
        }
        res.set('Cache-Control', 'public, max-age=300').json(trendingCache.tags);
    } catch (e) { res.json([]); }
});

app.post('/api/searchPosts', async (req, res) => {
    const query = String(req.body.query || '').slice(0, 60).replace(/[%,]/g, ' ').trim();
    if (!query) return res.json([]);
    try {
        const { data: posts, error: postsErr } = await supabase.from('posts').select('*').ilike('text', `%${query}%`).order('created_at', { ascending: false }).limit(15);
        if (postsErr) throw postsErr;

        const { data: videos, error: videosErr } = await supabase.from('videos').select('*').ilike('caption', `%${query}%`).order('created_at', { ascending: false }).limit(15);
        if (videosErr) console.error("Video search failed:", videosErr.message || videosErr);

        const enrichedPosts = (await enrichPosts(posts || [])).map(p => ({ ...p, content_type: 'post' }));
        const enrichedVideos = (await enrichVideos(videos || [])).map(v => ({ ...v, content_type: 'video', text: v.caption }));

        res.json([...enrichedPosts, ...enrichedVideos]);
    } catch (e) {
        res.status(500).json({ error: e.message || e });
    }
});

// Comments API (contentType: 'post' | 'video', defaults to 'post' for backward compatibility)
app.post('/api/getComments', async (req, res) => {
    const { postId, contentType = 'post' } = req.body;
    try {
        let { data, error } = await supabase.from('comments').select('*').eq('post_id', postId).eq('content_type', contentType).order('created_at', { ascending: true }).limit(200);
        if (error) {
            console.error("getComments (content_type filter) failed, falling back:", error.message || error);
            // Most likely the content_type column doesn't exist yet (shorts_migration.sql not run) — fall back to matching by post_id only.
            const fallback = await supabase.from('comments').select('*').eq('post_id', postId).order('created_at', { ascending: true }).limit(200);
            data = fallback.data;
        }
        res.json(data || []);
    } catch (e) {
        console.error("getComments crashed:", e);
        res.json([]);
    }
});

app.post('/api/addComment', async (req, res) => {
    const { initData, postId, contentType = 'post', parentId } = req.body;
    const text = String(req.body.text || '').slice(0, 1000);
    const tgUser = validateTGData(initData);
    if (!tgUser) return res.status(403).json({ error: "Unauthorized" });
    if (!text.trim()) return res.status(400).json({ error: "Empty comment" });

    try {
        const { data: user } = await supabase.from('users').select('name').eq('tg_id', tgUser.id.toString()).maybeSingle();
        const authorName = user ? user.name : tgUser.first_name || "Anonymous";

        // FIXED: Removed likes_count parameter to prevent crash if old DB tables do not have likes_count column
        let { data: insRows, error } = await supabase.from('comments').insert([{
            post_id: postId,
            author_id: tgUser.id.toString(),
            author_name: authorName,
            text,
            content_type: contentType,
            ...(parentId ? { parent_id: String(parentId) } : {})
        }]).select('id');
        let newCommentId = insRows && insRows[0] && insRows[0].id;
        if (error && parentId && /parent_id/i.test(error.message || '')) {
            return res.status(500).json({ error: "Replies need a database update: run sql/08_reactions_and_replies.sql in Supabase, then try again." });
        }
        if (error) {
            console.error("addComment (with content_type) failed, retrying without it:", error.message || error);
            // Fall back for DBs that haven't run shorts_migration.sql yet (no content_type column)
            const retry = await supabase.from('comments').insert([{
                post_id: postId,
                author_id: tgUser.id.toString(),
                author_name: authorName,
                text
            }]).select('id');
            if (retry.error) throw retry.error;
            newCommentId = retry.data && retry.data[0] && retry.data[0].id;
        }

        // Send Bot notification to post/video author or channel owners about the comment
        const table = contentType === 'video' ? 'videos' : 'posts';
        const textField = contentType === 'video' ? 'caption' : 'text';
        const { data: content } = await supabase.from(table).select(`author_id, ${textField}, type`).eq('id', postId).maybeSingle();
        if (content && String(content.author_id) !== tgUser.id.toString()) {
            const preview = content[textField] ? content[textField].substring(0, 20) : (contentType === 'video' ? 'Video Post' : 'Photo Post');
            await notifyPostOwners(
                content.author_id,
                content.type,
                `💬 ${tgUser.first_name} commented on your ${contentType}:\n"${preview}..."\n\nComment: "${text}"`,
                `${contentType}_${postId}`
            );
            notifyInApp(content.author_id, content.type, { type: 'comment', actor: { id: tgUser.id, name: tgUser.first_name }, targetType: contentType, targetId: postId, commentId: newCommentId, message: `commented: "${text.slice(0, 80)}"` });
        }

        // Reply + @mention notifications (each person at most once, never the commenter themselves)
        try {
            const me = tgUser.id.toString();
            const notified = new Set([me]);
            const who = tgUser.first_name || 'Someone';
            const snippet = text.length > 60 ? text.substring(0, 60) + '…' : text;
            if (parentId) {
                const { data: parent } = await supabase.from('comments').select('author_id').eq('id', parentId).maybeSingle();
                if (parent && !notified.has(String(parent.author_id))) {
                    notified.add(String(parent.author_id));
                    sendTelegramNotification(parent.author_id, `↩️ ${who} replied to your comment:\n"${snippet}"`, `${contentType}_${postId}`);
                    pushNotif(parent.author_id, { type: 'reply', actor: { id: me, name: who }, targetType: contentType, targetId: postId, commentId: newCommentId, message: `replied: "${text.slice(0, 80)}"` });
                }
            }
            const handles = [...new Set((text.match(/@([A-Za-z0-9_]{4,32})/g) || []).map(h => h.slice(1).toLowerCase()))].slice(0, 3);
            for (const h of handles) {
                let { data: m } = await supabase.from('users').select('tg_id').ilike('username', h).maybeSingle();
                if (!m) { const r2 = await supabase.from('users').select('tg_id').ilike('app_username', h).maybeSingle(); m = r2.data; }
                if (m && !notified.has(String(m.tg_id))) {
                    notified.add(String(m.tg_id));
                    sendTelegramNotification(m.tg_id, `📣 ${who} mentioned you in a comment:\n"${snippet}"`, `${contentType}_${postId}`);
                    pushNotif(m.tg_id, { type: 'mention', actor: { id: me, name: who }, targetType: contentType, targetId: postId, commentId: newCommentId, message: `mentioned you: "${text.slice(0, 80)}"` });
                }
            }
        } catch (e) { console.error('comment notifications failed:', e.message || e); }

        res.json({ success: true });
    } catch (e) {
        const msg = e.message || String(e);
        if (msg.includes('invalid input syntax for type uuid')) {
            return res.status(500).json({ error: "Video comments need a database fix: please run fix_comments_post_id_type.sql in Supabase, then try again." });
        }
        res.status(500).json({ error: msg });
    }
});

app.post('/api/deleteComment', async (req, res) => {
    const { initData, commentId } = req.body;
    const tgUser = validateTGData(initData);
    if (!tgUser) return res.status(403).json({ error: "Unauthorized" });
    const { error } = await supabase.from('comments').delete().match({ id: commentId, author_id: tgUser.id.toString() });
    if (!error) await supabase.from('comments').delete().eq('parent_id', String(commentId));   // remove its replies too (ignored if column missing)
    res.json({ success: true });
});

app.post('/api/likeComment', async (req, res) => {
    const { initData, commentId } = req.body;
    const tgUser = validateTGData(initData);
    if (!tgUser) return res.status(403).json({ error: "Unauthorized" });

    try {
        const { data: comment, error: fetchErr } = await supabase.from('comments').select('likes_count, likes_users, author_id, post_id, content_type').eq('id', commentId).maybeSingle();
        if (fetchErr || !comment) return res.status(404).json({ error: "Comment not found" });

        let likesUsers = comment.likes_users || [];
        let likesCount = comment.likes_count || 0;
        const userId = tgUser.id.toString();
        let hasLiked = false;

        if (likesUsers.includes(userId)) {
            likesUsers = likesUsers.filter(id => id !== userId);
            likesCount = Math.max(0, likesCount - 1);
        } else {
            likesUsers.push(userId);
            likesCount += 1;
            hasLiked = true;
            pushNotif(comment.author_id, { type: 'comment_like', actor: { id: userId, name: tgUser.first_name }, targetType: comment.content_type === 'video' ? 'video' : 'post', targetId: comment.post_id, commentId, message: 'liked your comment' });
        }

        const { error: updateErr } = await supabase.from('comments').update({ likes_count: likesCount, likes_users: likesUsers }).eq('id', commentId);
        if (updateErr) throw updateErr;

        res.json({ success: true, likesCount, hasLiked });
    } catch (e) {
        res.status(500).json({ error: e.message || e });
    }
});

// ================= SHORTS VIDEO APIs =================
// Videos are never stored in Supabase directly — only Telegram's file_id is kept.
// User uploads go through a dedicated storage channel (STORAGE_CHANNEL_ID); channel
// videos are auto-synced straight from the origin channel_post (see bot.on('channel_post')).

async function enrichVideos(videos) {
    const list = await enrichAuthors(videos);
    return list.map(v => ({ ...v, stream_url: `/api/videoStream/${v.id}` }));
}

// Paginated Shorts feed
app.post('/api/getShorts', async (req, res) => {
    const { page = 1, authorId } = req.body;
    const limit = Math.min(parseInt(req.body.limit) || 5, 20);
    const offset = (parseInt(page) - 1) * limit;
    try {
        let q = supabase.from('videos').select('*');
        if (authorId) q = q.eq('author_id', String(authorId));
        const { data: videos, error } = await q
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);
        if (error) throw error;
        res.json(await enrichVideos(videos || []));
    } catch (e) {
        console.error("Shorts feed error:", e);
        res.json([]);
    }
});

// Single video (used to open a share/deep link straight to a specific Short)
app.post('/api/getVideoById', async (req, res) => {
    const { videoId } = req.body;
    try {
        const { data: video, error } = await supabase.from('videos').select('*').eq('id', videoId).maybeSingle();
        if (error || !video) return res.status(404).json({ error: "Video not found" });
        const [enriched] = await enrichVideos([video]);
        res.json(enriched);
    } catch (e) {
        res.status(500).json({ error: e.message || e });
    }
});

// Single post (used to open a share/deep link straight to a specific post)
app.post('/api/getPostById', async (req, res) => {
    const { postId } = req.body;
    try {
        const { data: post, error } = await supabase.from('posts').select('*').eq('id', postId).maybeSingle();
        if (error || !post) return res.status(404).json({ error: "Post not found" });
        const [enriched] = await enrichPosts([post]);
        res.json(enriched);
    } catch (e) {
        res.status(500).json({ error: e.message || e });
    }
});

// Resolves a video's file_id to a fresh, short-lived Telegram CDN link and redirects to it.
// We never persist the raw link since Telegram's file links expire (~1 hour).
const fileLinkCache = new Map();
async function getCachedFileLink(fileId) {
    const hit = fileLinkCache.get(fileId);
    if (hit && hit.exp > Date.now()) return hit.url;
    const link = await bot.telegram.getFileLink(fileId);
    const url = link.href || link.toString();
    fileLinkCache.set(fileId, { url, exp: Date.now() + 50 * 60 * 1000 });
    if (fileLinkCache.size > 3000) fileLinkCache.delete(fileLinkCache.keys().next().value);
    return url;
}

app.get('/api/videoStream/:id', async (req, res) => {
    try {
        const { data: video } = await supabase.from('videos').select('file_id').eq('id', req.params.id).maybeSingle();
        if (!video) return res.status(404).send("Video not found");
        res.redirect(await getCachedFileLink(video.file_id));
    } catch (e) {
        res.status(500).send("Could not resolve video stream");
    }
});

// Same idea as videoStream, but for images (profile photos, channel avatars, post/channel
// photos) — replaces the old ImgBB-hosted URLs entirely.
app.get('/api/tgImage/:fileId', async (req, res) => {
    try {
        res.set('Cache-Control', 'public, max-age=3000');
        res.redirect(await getCachedFileLink(req.params.fileId));
    } catch (e) {
        res.status(404).send("Image not found");
    }
});

// Upload a new video (users only — channels are captured automatically via channel_post)
app.post('/api/createVideo', async (req, res) => {
    const { initData, caption, videoBase64 } = req.body;
    const tgUser = validateTGData(initData);
    if (!tgUser) return res.status(403).json({ error: "Unauthorized" });
    if (!videoBase64) return res.status(400).json({ error: "No video provided" });
    const STORAGE_CHANNEL_ID = await getStorageChannel();
    if (!STORAGE_CHANNEL_ID) return res.status(500).json({ error: "Storage channel is not set. Admin: open Admin panel → Storage Channel." });

    try {
        const base64Data = videoBase64.includes(',') ? videoBase64.split(',')[1] : videoBase64;
        const buffer = Buffer.from(base64Data, 'base64');

        if (buffer.length > MAX_VIDEO_BYTES) {
            return res.status(400).json({ error: "Video exceeds the 15MB limit" });
        }

        const { data: user } = await supabase.from('users').select('name').eq('tg_id', tgUser.id.toString()).maybeSingle();
        const authorName = user ? user.name : tgUser.first_name || "User";

        const sentMsg = await bot.telegram.sendVideo(
            STORAGE_CHANNEL_ID,
            { source: buffer, filename: `snappages_${Date.now()}.mp4` },
            { caption: `From: ${authorName} (${tgUser.id})` }
        );

        const fileId = sentMsg.video ? sentMsg.video.file_id : null;
        if (!fileId) return res.status(500).json({ error: "Upload to storage channel failed" });

        const { error } = await supabase.from('videos').insert([{
            author_id: tgUser.id.toString(),
            author_name: authorName,
            type: 'user',
            caption: caption || '',
            file_id: fileId,
            storage_chat_id: String(STORAGE_CHANNEL_ID),
            storage_message_id: sentMsg.message_id,
            owned_storage: true,
            likes_count: 0,
            likes_users: [],
            created_at: new Date().toISOString()
        }]);
        if (error) throw error;

        await enforceVideoCap();
        res.json({ success: true });
    } catch (e) {
        console.error("Video upload failed:", e);
        res.status(500).json({ error: e.message || e });
    }
});

app.post('/api/deleteVideo', async (req, res) => {
    const { initData, videoId } = req.body;
    const tgUser = validateTGData(initData);
    if (!tgUser) return res.status(403).json({ error: "Unauthorized" });

    try {
        const { data: video } = await supabase.from('videos').select('*').eq('id', videoId).maybeSingle();
        if (!video) return res.status(404).json({ error: "Video not found" });

        const { data: user } = await supabase.from('users').select('*').eq('tg_id', tgUser.id.toString()).maybeSingle();
        let isOwner = false;
        if (video.type === 'channel') {
            isOwner = user && user.channels && user.channels.some(c => String(c.id) === String(video.author_id));
        } else {
            isOwner = String(video.author_id) === String(tgUser.id);
        }
        if (!isOwner) return res.status(403).json({ error: "You do not own this video!" });

        if (video.owned_storage && video.storage_chat_id && video.storage_message_id) {
            try { await bot.telegram.deleteMessage(video.storage_chat_id, video.storage_message_id); } catch (e) {}
        }
        await supabase.from('videos').delete().eq('id', videoId);
        await supabase.from('comments').delete().eq('post_id', videoId).eq('content_type', 'video');
        await supabase.from('reports').delete().eq('post_id', videoId).eq('content_type', 'video');
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message || e });
    }
});

app.post('/api/likeVideo', async (req, res) => {
    const { initData, videoId } = req.body;
    const tgUser = validateTGData(initData);
    if (!tgUser) return res.status(403).json({ error: "Unauthorized" });

    try {
        const { data: video, error: fetchErr } = await supabase.from('videos').select('*').eq('id', videoId).maybeSingle();
        if (fetchErr || !video) return res.status(404).json({ error: "Video not found" });

        let likesUsers = video.likes_users || [];
        let likesCount = video.likes_count || 0;
        const userId = tgUser.id.toString();
        let hasLiked = false;

        if (likesUsers.includes(userId)) {
            likesUsers = likesUsers.filter(id => id !== userId);
            likesCount = Math.max(0, likesCount - 1);
        } else {
            likesUsers.push(userId);
            likesCount += 1;
            hasLiked = true;
            const preview = video.caption ? video.caption.substring(0, 30) : 'Video Post';
            await notifyPostOwners(video.author_id, video.type, `❤️ ${tgUser.first_name} liked your video:\n"${preview}..."`, `video_${videoId}`);
            notifyInApp(video.author_id, video.type, { type: 'like', actor: { id: userId, name: tgUser.first_name }, targetType: 'video', targetId: videoId, message: 'liked your video' });
        }

        const upd = { likes_count: likesCount, likes_users: likesUsers };
        let reactions = video.reactions || {};
        if (hasLiked && reactions[userId]) { reactions = { ...reactions }; delete reactions[userId]; upd.reactions = reactions; }
        await supabase.from('videos').update(upd).eq('id', videoId);
        res.json({ success: true, likesCount: likesCount + Object.keys(reactions).length, hasLiked, hearts: likesCount, reactions });
    } catch (e) {
        res.status(500).json({ error: e.message || e });
    }
});

app.post('/api/reportVideo', async (req, res) => {
    const { initData, videoId, reason } = req.body;
    const tgUser = validateTGData(initData);
    if (!tgUser) return res.status(403).json({ error: "Unauthorized" });

    try {
        const { data: video } = await supabase.from('videos').select('id, author_id, type').eq('id', videoId).maybeSingle();
        if (!video) return res.status(404).json({ error: "Video not found" });

        const error = await insertReportRow({
            post_id: String(videoId),
            post_author_id: String(video.author_id),
            post_type: video.type,
            content_type: 'video',
            reporter_id: tgUser.id.toString(),
            reason: reason || 'Not specified',
            created_at: new Date().toISOString()
        });
        if (error) { console.error('Report insert failed:', error.message); throw error; }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message || e });
    }
});

// "Save" sends the video straight to the user's own chat with the bot
app.post('/api/saveVideo', async (req, res) => {
    const { initData, videoId } = req.body;
    const tgUser = validateTGData(initData);
    if (!tgUser) return res.status(403).json({ error: "Unauthorized" });

    try {
        const { data: video } = await supabase.from('videos').select('file_id, caption').eq('id', videoId).maybeSingle();
        if (!video) return res.status(404).json({ error: "Video not found" });

        await bot.telegram.sendVideo(tgUser.id, video.file_id, { caption: video.caption ? `Saved from SnapPages\n\n${video.caption}` : 'Saved from SnapPages' });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message || e });
    }
});
// All routes below require the caller to (a) be flagged is_admin in the users table AND
// (b) supply the correct adminPassword (set via the ADMIN_PASSWORD env var on Render).

app.post('/api/admin/login', requireAdminUser, requireAdminPassword, async (req, res) => {
    res.json({ success: true });
});

app.post('/api/admin/dashboard', requireAdminUser, requireAdminPassword, async (req, res) => {
    try {
        const { count: totalUsers } = await supabase.from('users').select('*', { count: 'exact', head: true });
        const { count: totalPosts } = await supabase.from('posts').select('*', { count: 'exact', head: true });
        const { count: totalVideos } = await supabase.from('videos').select('*', { count: 'exact', head: true });
        const { data: allUsers } = await supabase.from('users').select('channels');
        const totalChannels = (allUsers || []).reduce((sum, u) => sum + ((u.channels && u.channels.length) || 0), 0);
        const { count: totalReports } = await supabase.from('reports').select('*', { count: 'exact', head: true });

        const mem = process.memoryUsage();
        const ramUsedMB = Math.round(mem.rss / 1024 / 1024);

        // Posts created per day for the last 7 days (for the activity chart)
        const since = new Date();
        since.setDate(since.getDate() - 6);
        since.setHours(0, 0, 0, 0);
        const { data: recentPosts } = await supabase.from('posts').select('created_at').gte('created_at', since.toISOString());

        const dayLabels = [];
        const dayCounts = {};
        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const key = d.toISOString().slice(0, 10);
            dayLabels.push(key);
            dayCounts[key] = 0;
        }
        (recentPosts || []).forEach(p => {
            const key = (p.created_at || '').slice(0, 10);
            if (dayCounts[key] !== undefined) dayCounts[key]++;
        });

        res.json({
            totalUsers: totalUsers || 0,
            totalPosts: totalPosts || 0,
            totalVideos: totalVideos || 0,
            totalChannels,
            totalReports: totalReports || 0,
            ramUsedMB,
            uptimeSeconds: Math.round(process.uptime()),
            activity: { labels: dayLabels, counts: dayLabels.map(k => dayCounts[k]) }
        });
    } catch (e) {
        res.status(500).json({ error: e.message || e });
    }
});

app.post('/api/admin/reports', requireAdminUser, requireAdminPassword, async (req, res) => {
    try {
        const { data: reports, error } = await supabase.from('reports').select('*').order('created_at', { ascending: false });
        if (error) throw error;

        // Group reports by (content_type, post_id) — posts and videos each have their own
        // auto-incrementing id, so the id alone isn't a unique key across both tables.
        const grouped = {};
        (reports || []).forEach(r => {
            const contentType = r.content_type || 'post';
            const key = `${contentType}:${r.post_id}`;
            if (!grouped[key]) grouped[key] = { post_id: r.post_id, content_type: contentType, post_author_id: r.post_author_id, post_type: r.post_type, reasons: [], count: 0 };
            grouped[key].count++;
            grouped[key].reasons.push(r.reason);
        });

        const postEntries = Object.values(grouped).filter(g => g.content_type === 'post');
        const videoEntries = Object.values(grouped).filter(g => g.content_type === 'video');

        if (postEntries.length > 0) {
            const { data: posts } = await supabase.from('posts').select('*').in('id', postEntries.map(g => g.post_id));
            (posts || []).forEach(p => {
                const g = grouped[`post:${p.id}`];
                if (g) {
                    g.post_text = p.text;
                    g.post_link = `${process.env.MINI_APP_URL}?startapp=post_${p.id}`;
                }
            });
        }
        if (videoEntries.length > 0) {
            const { data: videos } = await supabase.from('videos').select('id, caption').in('id', videoEntries.map(g => g.post_id));
            (videos || []).forEach(v => {
                const g = grouped[`video:${v.id}`];
                if (g) {
                    g.post_text = v.caption;
                    g.post_link = `${process.env.MINI_APP_URL}?startapp=video_${v.id}`;
                }
            });
        }

        res.json(Object.values(grouped));
    } catch (e) {
        res.status(500).json({ error: e.message || e });
    }
});

app.post('/api/admin/removePost', requireAdminUser, requireAdminPassword, async (req, res) => {
    const { postId, contentType = 'post' } = req.body;
    try {
        if (contentType === 'video') {
            const { data: video } = await supabase.from('videos').select('*').eq('id', postId).maybeSingle();
            if (video && video.owned_storage && video.storage_chat_id && video.storage_message_id) {
                try { await bot.telegram.deleteMessage(video.storage_chat_id, video.storage_message_id); } catch (e) {}
            }
            await supabase.from('videos').delete().eq('id', postId);
        } else {
            await supabase.from('posts').delete().eq('id', postId);
        }
        await supabase.from('reports').delete().eq('post_id', postId).eq('content_type', contentType);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message || e }); }
});

app.post('/api/admin/removePostBanUser', requireAdminUser, requireAdminPassword, async (req, res) => {
    const { postId, contentType = 'post' } = req.body;
    try {
        const table = contentType === 'video' ? 'videos' : 'posts';
        const { data: content } = await supabase.from(table).select('*').eq('id', postId).maybeSingle();
        if (!content) return res.status(404).json({ error: "Content not found" });

        if (content.type === 'channel') {
            // Ban the channel instead of a user
            await banChannelInternal(content.author_id);
        } else {
            await banUserInternal(content.author_id);
        }

        if (contentType === 'video' && content.owned_storage && content.storage_chat_id && content.storage_message_id) {
            try { await bot.telegram.deleteMessage(content.storage_chat_id, content.storage_message_id); } catch (e) {}
        }
        await supabase.from(table).delete().eq('id', postId);
        await supabase.from('reports').delete().eq('post_id', postId).eq('content_type', contentType);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message || e }); }
});

app.post('/api/admin/banChannel', requireAdminUser, requireAdminPassword, async (req, res) => {
    const { channelId } = req.body;
    try {
        await banChannelInternal(channelId);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message || e }); }
});

// Deletes everything belonging to a user: their own posts/videos/comments, AND anything
// posted through channels they registered for auto-posting (since those exist because of
// this user). Does NOT add them to banned_users — call banUserInternal for that.
async function deleteUserDataInternal(tgId) {
    const id = tgId.toString();
    const { data: userRow } = await supabase.from('users').select('channels').eq('tg_id', id).maybeSingle();
    if (!userRow) return false;

    // Remove content from channels this user registered for auto-posting
    for (const ch of (userRow.channels || [])) {
        await supabase.from('posts').delete().eq('author_id', ch.id.toString());
        await supabase.from('videos').delete().eq('author_id', ch.id.toString());
    }

    await supabase.from('posts').delete().eq('author_id', id);
    await supabase.from('comments').delete().eq('author_id', id);

    // Purge any videos this user uploaded, cleaning up storage channel messages we own
    const { data: userVideos } = await supabase.from('videos').select('id, owned_storage, storage_chat_id, storage_message_id').eq('author_id', id);
    for (const v of (userVideos || [])) {
        if (v.owned_storage && v.storage_chat_id && v.storage_message_id) {
            try { await bot.telegram.deleteMessage(v.storage_chat_id, v.storage_message_id); } catch (e) {}
        }
    }
    await supabase.from('videos').delete().eq('author_id', id);

    await supabase.from('users').delete().eq('tg_id', id);
    return true;
}

async function banUserInternal(tgId) {
    await deleteUserDataInternal(tgId);
    await supabase.from('banned_users').upsert([{ tg_id: tgId.toString(), banned_at: new Date().toISOString() }]);
}

async function banChannelInternal(channelId) {
    await supabase.from('banned_channels').upsert([{ channel_id: channelId.toString(), banned_at: new Date().toISOString() }]);
    await supabase.from('posts').delete().eq('author_id', channelId.toString());
    await supabase.from('videos').delete().eq('author_id', channelId.toString()); // channel-owned messages, never delete the source message
    // strip the channel out of every user's channels array
    const { data: allUsers } = await supabase.from('users').select('tg_id, channels');
    for (const owner of (allUsers || [])) {
        if (!owner.channels || !owner.channels.some(c => String(c.id) === String(channelId))) continue;
        const updated = owner.channels.filter(c => String(c.id) !== String(channelId));
        await supabase.from('users').update({ channels: updated }).eq('tg_id', owner.tg_id);
        invalidateAuthorCaches();
    }
}

// Resolves an admin-provided "chat ID or @username" into that user's tg_id
async function resolveUserIdByInput(targetId) {
    const clean = targetId.toString().trim().replace('@', '');
    let query = supabase.from('users').select('tg_id');
    if (/^\d+$/.test(clean)) {
        query = query.eq('tg_id', clean);
    } else {
        query = query.ilike('username', clean);
    }
    const { data } = await query.maybeSingle();
    return data ? data.tg_id : null;
}

app.post('/api/admin/deleteUserData', requireAdminUser, requireAdminPassword, async (req, res) => {
    const { targetId, alsoBan } = req.body;
    if (!targetId) return res.status(400).json({ error: "Provide a username or chat ID" });
    try {
        const tgId = await resolveUserIdByInput(targetId);
        if (!tgId) return res.status(404).json({ error: "No user found with that username or chat ID" });

        if (alsoBan) {
            await banUserInternal(tgId);
        } else {
            await deleteUserDataInternal(tgId);
        }
        res.json({ success: true, banned: !!alsoBan });
    } catch (e) {
        res.status(500).json({ error: e.message || e });
    }
});

app.post('/api/admin/broadcast', requireAdminUser, requireAdminPassword, async (req, res) => {
    const { message, imageUrl, buttonText, buttonUrl, pinAll } = req.body;
    try {
        const { data: users } = await supabase.from('users').select('tg_id');
        let sent = 0;

        const extra = { parse_mode: 'HTML' };
        if (buttonText && buttonUrl) {
            extra.reply_markup = Markup.inlineKeyboard([[Markup.button.url(buttonText, buttonUrl)]]).reply_markup;
        }

        for (const u of (users || [])) {
            try {
                let sentMsg;
                if (imageUrl) {
                    sentMsg = await bot.telegram.sendPhoto(u.tg_id, imageUrl, { caption: message, ...extra });
                } else {
                    sentMsg = await bot.telegram.sendMessage(u.tg_id, message, extra);
                }
                sent++;
                if (pinAll && sentMsg) {
                    try { await bot.telegram.pinChatMessage(u.tg_id, sentMsg.message_id); } catch (pinErr) {}
                }
            } catch (sendErr) {
                // user may have blocked the bot; skip
            }
        }

        res.json({ success: true, sent });
    } catch (e) {
        res.status(500).json({ error: e.message || e });
    }
});

// Set / remove blue verified badge for a user or a channel
app.post('/api/admin/setBadge', requireAdminUser, requireAdminPassword, async (req, res) => {
    const { targetId, type, action } = req.body; // type: 'user' | 'channel', action: 'add' | 'remove'
    try {
        const verified = action === 'add';
        if (type === 'channel') {
            const cleanInput = targetId.toString().trim();
            // Normalize a bare numeric channel ID the same way addChannel does (some UIs show
            // the ID without its -100 prefix), and also allow matching by @username.
            let normalizedId = null;
            if (/^-100\d+$/.test(cleanInput)) {
                normalizedId = cleanInput;
            } else if (/^-\d+$/.test(cleanInput)) {
                normalizedId = cleanInput;
            } else if (/^\d+$/.test(cleanInput)) {
                normalizedId = `-100${cleanInput}`;
            }
            const cleanUsername = cleanInput.replace('@', '').toLowerCase();

            const { data: allUsers, error: fetchErr } = await supabase.from('users').select('tg_id, channels');
            if (fetchErr) throw fetchErr;

            let matched = false;
            let writeError = null;
            for (const owner of (allUsers || [])) {
                if (!owner.channels || owner.channels.length === 0) continue;
                let changed = false;
                const updated = owner.channels.map(c => {
                    const idMatch = normalizedId && String(c.id) === String(normalizedId);
                    const usernameMatch = c.username && c.username !== 'private' && c.username.toLowerCase() === cleanUsername;
                    if (idMatch || usernameMatch) {
                        changed = true;
                        return { ...c, verified };
                    }
                    return c;
                });
                if (changed) {
                    const { error: updateErr } = await supabase.from('users').update({ channels: updated }).eq('tg_id', owner.tg_id);
        invalidateAuthorCaches();
                    if (updateErr) {
                        writeError = updateErr;
                        console.error(`setBadge: failed to save channel badge for owner ${owner.tg_id}:`, updateErr);
                    } else {
                        matched = true;
                    }
                }
            }
            if (writeError && !matched) {
                return res.status(500).json({ error: `Found the channel but failed to save the badge: ${writeError.message || writeError}` });
            }
            if (!matched) {
                return res.status(404).json({ error: "No matching channel found. Make sure it has already been added by a user via Auto Post Channels." });
            }
        } else {
            // Resolve by tg_id or by @username
            let query = supabase.from('users').update({ is_verified: verified });
            const clean = targetId.toString().replace('@', '');
            if (/^\d+$/.test(clean)) {
                query = query.eq('tg_id', clean);
            } else {
                query = query.eq('username', clean);
            }
            const { data, error } = await query.select();
            if (error) throw error;
            if (!data || data.length === 0) {
                return res.status(404).json({ error: "No matching user found with that chat ID or username." });
            }
        }
        invalidateAuthorCaches();
        userLevelCache.clear();
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message || e });
    }
});

// Pin / unpin a post so it always shows at the top of everyone's feed
app.post('/api/admin/pinPost', requireAdminUser, requireAdminPassword, async (req, res) => {
    const { postId, action } = req.body; // action: 'pin' | 'unpin'
    try {
        let resolvedId = postId;
        if (postId && postId.includes('startapp=post_')) {
            resolvedId = postId.split('startapp=post_')[1];
        }
        const { error } = await supabase.from('posts').update({ is_pinned: action === 'pin' }).eq('id', resolvedId);
        if (error) throw error;
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message || e });
    }
});

app.post('/api/admin/maintenance', requireAdminUser, requireAdminPassword, async (req, res) => {
    const { enabled } = req.body;
    try {
        await supabase.from('app_settings').upsert([{ key: 'maintenance_mode', value: enabled ? 'true' : 'false' }]);
        maintenanceCache = { enabled: !!enabled, ts: Date.now() };
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message || e });
    }
});

// Storage channel: where uploaded photos/videos are kept (the bot must be an admin there)
app.post('/api/admin/getStorageChannel', requireAdminUser, requireAdminPassword, async (req, res) => {
    const id = await getStorageChannel(true);
    res.json({ id: id || '', fromEnv: !!ENV_STORAGE_CHANNEL_ID && id === ENV_STORAGE_CHANNEL_ID });
});
app.post('/api/admin/setStorageChannel', requireAdminUser, requireAdminPassword, async (req, res) => {
    let id = String(req.body.id || '').trim();
    if (!id) return res.status(400).json({ error: "Enter the channel ID (like -1001234567890) or @username" });
    try {
        const chat = await bot.telegram.getChat(id);            // bot must be able to see it
        const me = await bot.telegram.getMe();
        const member = await bot.telegram.getChatMember(chat.id, me.id);
        if (!['administrator', 'creator'].includes(member.status)) {
            return res.status(400).json({ error: `Bot is not an admin in "${chat.title || id}". Add @${me.username} as admin with "Post messages" permission.` });
        }
        const test = await bot.telegram.sendMessage(chat.id, '✅ SnapPages storage channel connected');   // proves it can post
        bot.telegram.deleteMessage(chat.id, test.message_id).catch(() => {});
        await supabase.from('app_settings').upsert([{ key: 'storage_channel_id', value: String(chat.id) }]);
        storageCache = { id: String(chat.id), ts: Date.now() };
        res.json({ success: true, id: String(chat.id), title: chat.title || '' });
    } catch (e) {
        res.status(400).json({ error: `Telegram says: ${e.description || e.message || e}` });
    }
});

app.post('/api/admin/setSupportLink', requireAdminUser, requireAdminPassword, async (req, res) => {
    const { link } = req.body;
    if (!link || !/^https?:\/\//.test(link)) {
        return res.status(400).json({ error: "Please provide a valid https:// link" });
    }
    try {
        await supabase.from('app_settings').upsert([{ key: 'support_link', value: link }]);
        supportLinkCache = { link, ts: Date.now() };
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message || e });
    }
});

app.post('/api/admin/wipeDatabase', requireAdminUser, requireAdminPassword, async (req, res) => {
    const { confirm } = req.body;
    if (confirm !== 'WIPE') return res.status(400).json({ error: "Confirmation phrase mismatch" });
    try {
        await supabase.from('comments').delete().neq('id', 0);
        await supabase.from('reports').delete().neq('id', 0);
        await supabase.from('posts').delete().neq('id', 0);
        await supabase.from('videos').delete().neq('id', 0);
        await supabase.from('users').delete().neq('tg_id', '0');
        await supabase.from('banned_users').delete().neq('tg_id', '0');
        await supabase.from('banned_channels').delete().neq('channel_id', '0');
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message || e });
    }
});

// ---- Front-end delivery: HTML is tiny and never cached; CSS/JS/fonts are cached "forever"
// because every file URL carries ?v=<deploy id>, so a new deploy automatically busts the cache.
const fs = require('fs');
const ASSET_VERSION = (process.env.RENDER_GIT_COMMIT || String(Date.now())).slice(0, 8);
let indexHtmlCache = null;
function getIndexHtml() {
    if (!indexHtmlCache) {
        indexHtmlCache = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8').replace(/__V__/g, ASSET_VERSION);
    }
    return indexHtmlCache;
}
// ================= Stories (24-hour image status) =================
// Images live in the Telegram storage channel (like post images); only a small row per story is kept here.
// Rows are cached for 20s and expired ones are purged every ~30 min, so the free database barely notices them.
const STORY_TTL_MS = 24 * 3600 * 1000;
const MAX_ACTIVE_STORIES_PER_USER = 5;
let storyCache = { exp: 0, rows: [] };
let lastStoryPurge = 0;

async function getActiveStories() {
    if (storyCache.exp > Date.now()) return storyCache.rows;
    const since = new Date(Date.now() - STORY_TTL_MS).toISOString();
    const { data, error } = await supabase.from('stories').select('id, author_id, author_name, image_url, caption, created_at')
        .gte('created_at', since).order('created_at', { ascending: true }).limit(400);
    if (error) throw error;
    storyCache = { exp: Date.now() + 20 * 1000, rows: data || [] };
    if (Date.now() - lastStoryPurge > 30 * 60 * 1000) {
        lastStoryPurge = Date.now();
        supabase.from('stories').delete().lt('created_at', since).then(() => {}, () => {});
    }
    return storyCache.rows;
}

app.post('/api/getStories', async (req, res) => {
    const tgUser = validateTGData(req.body.initData);
    if (!tgUser) return res.status(403).json({ error: "Unauthorized" });
    try {
        const me = tgUser.id.toString();
        const rows = await getActiveStories();
        const groups = new Map();
        rows.forEach(r => {
            const g = groups.get(r.author_id) || { author_id: r.author_id, author_name: r.author_name, stories: [], latest: 0 };
            g.stories.push({ id: r.id, image_url: r.image_url, caption: r.caption, created_at: r.created_at });
            g.latest = Math.max(g.latest, new Date(r.created_at).getTime());
            groups.set(r.author_id, g);
        });
        const list = [...groups.values()];
        const following = new Set(await getFollowingIds(me));
        const rank = g => g.author_id === me ? 0 : (following.has(g.author_id) ? 1 : 2);
        list.sort((a, b) => rank(a) - rank(b) || b.latest - a.latest);
        const top = list.slice(0, 40);
        const enriched = await enrichAuthors(top.map(g => ({ type: 'user', author_id: g.author_id, author_name: g.author_name })));
        res.json(top.map((g, i) => ({
            author_id: g.author_id, author_name: g.author_name,
            author_photo: enriched[i].author_photo, author_verified: enriched[i].author_verified,
            isMe: g.author_id === me, stories: g.stories
        })));
    } catch (e) {
        console.error('getStories failed (run sql/10_stories.sql?):', e.message || e);
        res.json([]);
    }
});

app.post('/api/createStory', async (req, res) => {
    const { initData, image } = req.body;
    const caption = String(req.body.caption || '').slice(0, 200);
    const tgUser = validateTGData(initData);
    if (!tgUser) return res.status(403).json({ error: "Unauthorized" });
    if (!image || typeof image !== 'string' || image.length > 8 * 1024 * 1024) return res.status(400).json({ error: "Image missing or too large" });
    try {
        const user = await getOrCreateUser(tgUser);
        if (!user) return res.status(404).json({ error: "User not found" });
        const me = tgUser.id.toString();
        const since = new Date(Date.now() - STORY_TTL_MS).toISOString();
        const { count, error: cErr } = await supabase.from('stories').select('*', { count: 'exact', head: true }).eq('author_id', me).gte('created_at', since);
        if (cErr) return res.status(500).json({ error: "Stories need a database update: run sql/10_stories.sql in Supabase, then try again." });
        if ((count || 0) >= MAX_ACTIVE_STORIES_PER_USER) return res.status(429).json({ error: `You can have up to ${MAX_ACTIVE_STORIES_PER_USER} stories at a time. Delete one or wait 24 hours.` });

        const imageUrl = await uploadImageToTelegram(image);
        if (!imageUrl) return res.status(500).json({ error: "Image upload failed. Ask the admin to check the storage channel setup." });

        const { error } = await supabase.from('stories').insert([{ author_id: me, author_name: user.name, image_url: imageUrl, caption, created_at: new Date().toISOString() }]);
        if (error) throw error;
        storyCache.exp = 0;
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message || e });
    }
});

app.post('/api/deleteStory', async (req, res) => {
    const tgUser = validateTGData(req.body.initData);
    if (!tgUser) return res.status(403).json({ error: "Unauthorized" });
    try {
        await supabase.from('stories').delete().match({ id: req.body.id, author_id: tgUser.id.toString() });
        storyCache.exp = 0;
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message || e }); }
});

// ================= Weekly channel report (sent to channel owners via the bot) =================
async function sendWeeklyChannelReports() {
    const since = new Date(Date.now() - 7 * 86400000).toISOString();
    const channelMap = await getChannelMap();
    const byOwner = new Map();
    channelMap.forEach(({ ch, owner }, channelId) => {
        const list = byOwner.get(String(owner.tg_id)) || [];
        list.push({ id: channelId, name: ch.name || 'Channel' });
        byOwner.set(String(owner.tg_id), list);
    });
    let sent = 0;
    for (const [ownerId, channels] of byOwner) {
        const blocks = [];
        for (const ch of channels) {
            const { data: posts } = await supabase.from('posts').select('id, views, likes_count, reactions').eq('author_id', ch.id).gte('created_at', since).limit(500);
            const list = posts || [];
            const views = list.reduce((a, p) => a + (p.views || 0), 0);
            const reacts = list.reduce((a, p) => a + (p.likes_count || 0) + Object.keys(p.reactions || {}).length, 0);
            let comments = 0;
            if (list.length) {
                const { count } = await supabase.from('comments').select('*', { count: 'exact', head: true }).in('post_id', list.map(p => String(p.id))).gte('created_at', since);
                comments = count || 0;
            }
            const { count: followers } = await supabase.from('snap_follows').select('*', { count: 'exact', head: true }).eq('followee_id', ch.id).gte('created_at', since);
            if (!list.length && !followers) continue;   // nothing to report for a quiet channel
            blocks.push(`📣 ${ch.name}\n📝 ${list.length} new posts · 👁 ${views} views\n❤️ ${reacts} reactions · 💬 ${comments} comments\n👤 +${followers || 0} followers`);
        }
        if (blocks.length) {
            await sendTelegramNotification(ownerId, `📊 Your weekly channel report\n\n${blocks.join('\n\n')}`, '');
            sent++;
        }
    }
    return sent;
}

// Checked hourly; runs once on Sunday ~10:00 Bangladesh time (04:00 UTC). The week id stored in app_settings
// prevents a double send after a restart.
async function weeklyReportTick() {
    try {
        const now = new Date();
        if (now.getUTCDay() !== 0 || now.getUTCHours() !== 4) return;
        const weekId = now.toISOString().slice(0, 10);
        const { data } = await supabase.from('app_settings').select('value').eq('key', 'weekly_report_last').maybeSingle();
        if (data && data.value === weekId) return;
        await supabase.from('app_settings').upsert([{ key: 'weekly_report_last', value: weekId }]);
        const n = await sendWeeklyChannelReports();
        console.log(`Weekly reports sent to ${n} channel owner(s)`);
    } catch (e) { console.error('weekly report failed:', e.message || e); }
}
setInterval(weeklyReportTick, 60 * 60 * 1000);

// Admin: send the weekly reports right now (handy for testing)
app.post('/api/admin/sendWeeklyReports', requireAdminUser, requireAdminPassword, async (req, res) => {
    try { res.json({ success: true, sent: await sendWeeklyChannelReports() }); }
    catch (e) { res.status(500).json({ error: e.message || e }); }
});

// Lightweight health check (also what the self-ping below hits)
app.get('/healthz', (req, res) => res.type('text').send('ok'));

app.use('/assets', express.static(path.join(__dirname, 'assets'), {
    maxAge: '365d',
    immutable: true,
    index: false,
    setHeaders: (res, filePath) => {
        // Fonts are referenced without ?v= from CSS, so give them a shorter lifetime
        if (filePath.endsWith('.woff') || filePath.endsWith('.woff2')) res.setHeader('Cache-Control', 'public, max-age=2592000');
    }
}));
app.get('/', (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.type('html').send(getIndexHtml());
});
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'indexadmin.html')));
app.use(bot.webhookCallback('/webhook'));

// Render's free plan puts the service to sleep after ~15 min without traffic, and the first request
// after that takes 30-60s (the "loading forever" feeling). Pinging ourselves every 10 minutes keeps it
// awake. One always-on free service uses ~744 of the 750 free hours/month, so this fits the free plan.
if (process.env.RENDER_EXTERNAL_URL && typeof fetch === 'function') {
    setInterval(() => { fetch(`${process.env.RENDER_EXTERNAL_URL}/healthz`).catch(() => {}); }, 10 * 60 * 1000);
}

app.listen(process.env.PORT || 3000, async () => {
    console.log("Server Live!");
    await bot.telegram.setWebhook(`${process.env.RENDER_EXTERNAL_URL}/webhook`);
});
