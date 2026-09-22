require('dotenv').config();
const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const bot = new Telegraf(process.env.BOT_TOKEN);
const IMGBB_API = process.env.IMGBB_API_KEY || "a851fbf33917e751cb199be63c5663d7";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme";
// A private channel (bot must be admin) used purely as storage for user-uploaded Shorts videos,
// so raw video bytes never sit in Supabase — only the Telegram file_id is stored.
const STORAGE_CHANNEL_ID = process.env.STORAGE_CHANNEL_ID;
const MAX_VIDEO_BYTES = 18 * 1024 * 1024; // 18MB — Telegram Bot API can't reliably stream files near/above ~20MB
const MAX_VIDEOS_IN_DB = 300;

// ================= Referral Level Mapping =================
const getLevelData = (refs) => {
    if (refs >= 5) return { level: 3, limit: 999, channels: 5 };
    if (refs >= 3) return { level: 2, limit: 10, channels: 2 };
    return { level: 1, limit: 2, channels: 1 };
};

const validateTGData = (initData) => {
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

// ================= Smart ImgBB Base64 Upload Wrapper =================
async function uploadImageToImgBB(base64Str) {
    try {
        // Telegram's getFileLink can resolve to a URL object rather than a plain string
        // depending on the Telegraf version — normalize to string first.
        let cleanBase64 = typeof base64Str === 'string' ? base64Str : String(base64Str);
        if (cleanBase64.includes(',')) {
            cleanBase64 = cleanBase64.split(',')[1];
        }

        const params = new URLSearchParams();
        params.append('image', cleanBase64);

        const res = await axios.post(`https://api.imgbb.com/1/upload?key=${IMGBB_API}`, params, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        if (res.data && res.data.data && res.data.data.url) {
            return res.data.data.url;
        }
    } catch (e) {
        console.error("ImgBB upload failed details:", e.response ? e.response.data : e.message);
    }
    return null;
}

// ================= Bot Notification Helper (with Inline WebApp Button) =================
async function sendTelegramNotification(targetTgId, text, startappParam = "") {
    if (!targetTgId) return;
    try {
        const appUrl = startappParam
            ? `${process.env.MINI_APP_URL}?startapp=${startappParam}`
            : process.env.MINI_APP_URL;

        await bot.telegram.sendMessage(targetTgId, text, Markup.inlineKeyboard([
            [Markup.button.webApp('Open App 🚀', appUrl)]
        ]));
    } catch (err) {
        console.error(`Failed to send TG notification to ${targetTgId}:`, err.message);
    }
}

// ================= Notify Owners (Resolves Channel Post Likes/Comments Notifications to Channel Owner) =================
async function notifyPostOwners(postAuthorId, postType, messageText, startappParam) {
    try {
        if (postType === 'channel') {
            const { data: owners } = await supabase.from('users').select('tg_id').contains('channels', [{ id: postAuthorId }]);
            if (owners && owners.length > 0) {
                owners.forEach(owner => {
                    sendTelegramNotification(owner.tg_id, messageText, startappParam);
                });
            }
        } else {
            sendTelegramNotification(postAuthorId, messageText, startappParam);
        }
    } catch (err) {
        console.error("Notification forwarding failed:", err);
    }
}

// ================= Auto Fetch Telegram Profile Photo =================
async function getTgProfilePic(tgId) {
    try {
        const photos = await bot.telegram.getUserProfilePhotos(tgId, 0, 1);
        if (photos.total_count > 0) {
            const fileId = photos.photos[0][0].file_id;
            const link = await bot.telegram.getFileLink(fileId);
            const uploadedUrl = await uploadImageToImgBB(link);
            if (uploadedUrl) return uploadedUrl;
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
        if (payload.startsWith("ref_")) {
            referred_by = payload.replace("ref_", "");

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
    ctx.reply('Welcome to SnapPages! 🚀', Markup.inlineKeyboard([ Markup.button.webApp('Open App', process.env.MINI_APP_URL) ]));
});

// ================= Channel Auto Sync =================
bot.on('channel_post', async (ctx) => {
    const channelId = ctx.update.channel_post.chat.id.toString();
    const msg = ctx.update.channel_post;

    // Skip banned channels entirely
    const { data: bannedChannel } = await supabase.from('banned_channels').select('channel_id').eq('channel_id', channelId).maybeSingle();
    if (bannedChannel) return;

    const { data: users, error } = await supabase.from('users').select('channels');
    if (error) return;

    let isRegistered = false;
    users?.forEach(u => {
        if (u.channels && Array.isArray(u.channels)) {
            if (u.channels.some(c => String(c.id) === String(channelId))) {
                isRegistered = true;
            }
        }
    });

    if (isRegistered) {
        try {
            // Videos go to the Shorts feed (videos table); everything else stays a regular post.
            if (msg.video) {
                await supabase.from('videos').insert([{
                    author_id: channelId,
                    author_name: msg.chat.title || 'Channel Post',
                    type: 'channel',
                    caption: msg.caption || '',
                    file_id: msg.video.file_id,
                    storage_chat_id: channelId,
                    storage_message_id: msg.message_id,
                    owned_storage: false, // it's the channel's own message, we must never delete it
                    likes_count: 0,
                    likes_users: [],
                    created_at: new Date().toISOString()
                }]);
                await enforceVideoCap();
                return;
            }

            let imageUrls = [];
            if (msg.photo) {
                try {
                    const fileLink = await bot.telegram.getFileLink(msg.photo[msg.photo.length - 1].file_id);
                    const uploadedUrl = await uploadImageToImgBB(fileLink);
                    if (uploadedUrl) imageUrls.push(uploadedUrl);
                } catch(imgErr) {
                    console.error("Auto Sync ImgBB upload failed:", imgErr);
                }
            }

            const textContent = msg.text || msg.caption || '';

            await supabase.from('posts').insert([{
                author_id: channelId,
                author_name: msg.chat.title || 'Channel Post',
                type: 'channel',
                text: textContent,
                image_urls: imageUrls,
                likes_count: 0,
                likes_users: [],
                is_pinned: false,
                created_at: new Date().toISOString()
            }]);

            await enforcePostCap();
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
            if (startParam.startsWith("ref_")) {
                referred_by = startParam.replace("ref_", "");

                sendTelegramNotification(
                    referred_by,
                    `🎉 New Refer Joined!\n\n${tgUser.first_name} has joined using your referral link. Check your Level Stats inside the Referral Center.`,
                    "settings"
                );
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
    const { page = 1, limit = 10 } = req.body;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    try {
        let query = supabase.from('posts').select('*');

        if (parseInt(page) === 1) {
            // On page 1, surface pinned posts first, then the rest by recency
            const { data: pinned } = await supabase.from('posts').select('*').eq('is_pinned', true).order('created_at', { ascending: false });
            const { data: rest, error } = await supabase.from('posts')
                .select('*')
                .eq('is_pinned', false)
                .order('created_at', { ascending: false })
                .range(0, limit - 1);
            if (error) throw error;
            const combined = [...(pinned || []), ...(rest || [])];
            return res.json(await enrichPosts(combined));
        }

        const { data: posts, error } = await supabase.from('posts')
            .select('*')
            .eq('is_pinned', false)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (error) throw error;
        res.json(await enrichPosts(posts || []));
    } catch (e) {
        console.error("Feed error:", e);
        res.json([]);
    }
});

async function enrichPosts(posts) {
    if (!posts) return [];
    return Promise.all(posts.map(async post => {
        let authPhoto = `https://ui-avatars.com/api/?name=${encodeURIComponent(post.author_name || 'U')}`;
        let authorLevel = 1;
        let authorUsername = '';
        let authorVerified = false;

        try {
            if (post.type === 'user') {
                const { data: u } = await supabase.from('users').select('photo_url, username, tg_id, is_verified').eq('tg_id', post.author_id).maybeSingle();
                if (u) {
                    if (u.photo_url) authPhoto = u.photo_url;
                    if (u.username) authorUsername = u.username;
                    authorVerified = !!u.is_verified;
                }

                const { count: refCount } = await supabase.from('users').select('*', { count: 'exact', head: true }).eq('referred_by', post.author_id);
                authorLevel = authorVerified ? 3 : getLevelData(refCount || 0).level;
            } else if (post.type === 'channel') {
                const { data: u } = await supabase.from('users').select('channels, is_verified').contains('channels', [{ id: post.author_id }]);
                if (u && u.length > 0) {
                    const owner = u[0];
                    const ch = owner.channels.find(c => String(c.id) === String(post.author_id));
                    if (ch) {
                        if (ch.photo) authPhoto = ch.photo;
                        if (ch.username) authorUsername = ch.username;
                        // A verified user's own channels inherit the blue badge too
                        authorVerified = !!ch.verified || !!owner.is_verified;
                    }
                }
            }
        } catch(e) {}

        return {
            ...post,
            author_photo: authPhoto,
            author_level: authorLevel,
            author_username: authorUsername,
            author_verified: authorVerified
        };
    }));
}

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

// Create Post (Using ImgBB upload and RLS Bypass)
app.post('/api/createPost', async (req, res) => {
    const { initData, text, imagesBase64 } = req.body;
    const tgUser = validateTGData(initData);
    if (!tgUser) return res.status(403).json({ error: "Unauthorized" });

    try {
        const user = await getOrCreateUser(tgUser);
        if (!user) return res.status(404).json({ error: "Could not create your user record. Please check Render logs for details." });

        let imageUrls = [];
        let uploadFailures = 0;
        if (imagesBase64 && imagesBase64.length > 0) {
            for (let img of imagesBase64) {
                const uploadedUrl = await uploadImageToImgBB(img);
                if (uploadedUrl) {
                    imageUrls.push(uploadedUrl);
                } else {
                    uploadFailures++;
                }
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
            console.error(`createPost: ${uploadFailures} image(s) failed to upload to ImgBB — check IMGBB_API_KEY is a valid personal key.`);
            response.warning = `Post created, but ${uploadFailures} image(s) failed to upload. Ask the admin to check the ImgBB API key.`;
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

        const { error } = await supabase.from('posts').update({
            text,
            image_urls: imageUrls
        }).eq('id', postId);

        if (error) throw error;
        res.json({ success: true });
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
        const { data: post, error: fetchErr } = await supabase.from('posts').select('likes_count, likes_users, author_id, text, type').eq('id', postId).maybeSingle();
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
            }

            const { error: updateErr } = await supabase.from('posts').update({
                likes_count: likesCount,
                likes_users: likesUsers
            }).eq('id', postId);
            if (updateErr) throw updateErr;

            res.json({ success: true, likesCount, hasLiked });
        } else {
            res.status(404).json({ error: "Post not found" });
        }
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

        const { error } = await supabase.from('reports').insert([{
            post_id: postId,
            post_author_id: post.author_id,
            post_type: post.type,
            content_type: 'post',
            reporter_id: tgUser.id.toString(),
            reason: reason || 'Not specified',
            created_at: new Date().toISOString()
        }]);
        if (error) throw error;
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

        // Robust ImgBB photo upload in try-catch to prevent status code 400 crashes
        let photoUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(chat.title || 'C')}`;
        if (chat.photo) {
            try {
                const link = await bot.telegram.getFileLink(chat.photo.small_file_id);
                const uploadedUrl = await uploadImageToImgBB(link);
                if (uploadedUrl) photoUrl = uploadedUrl;
            } catch(imgErr) {
                console.log("Channel avatar upload failed, falling back gracefully:", imgErr);
            }
        }

        const cleanUsername = chat.username || 'private';
        channels.push({ id: chat.id.toString(), name: chat.title, username: cleanUsername, photo: photoUrl, verified: false });
        await supabase.from('users').update({ channels }).eq('tg_id', tgUser.id.toString());

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
        res.json({ success: true, channels });
    } catch (e) {
        res.status(500).json({ error: e.message || e });
    }
});

// Secure Search Posts API (Bypassing direct client-side RLS Blockage)
app.post('/api/searchPosts', async (req, res) => {
    const { query } = req.body;
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
        let { data, error } = await supabase.from('comments').select('*').eq('post_id', postId).eq('content_type', contentType).order('created_at', { ascending: true });
        if (error) {
            console.error("getComments (content_type filter) failed, falling back:", error.message || error);
            // Most likely the content_type column doesn't exist yet (shorts_migration.sql not run) — fall back to matching by post_id only.
            const fallback = await supabase.from('comments').select('*').eq('post_id', postId).order('created_at', { ascending: true });
            data = fallback.data;
        }
        res.json(data || []);
    } catch (e) {
        console.error("getComments crashed:", e);
        res.json([]);
    }
});

app.post('/api/addComment', async (req, res) => {
    const { initData, postId, text, contentType = 'post' } = req.body;
    const tgUser = validateTGData(initData);
    if (!tgUser) return res.status(403).json({ error: "Unauthorized" });

    try {
        const { data: user } = await supabase.from('users').select('name').eq('tg_id', tgUser.id.toString()).maybeSingle();
        const authorName = user ? user.name : tgUser.first_name || "Anonymous";

        // FIXED: Removed likes_count parameter to prevent crash if old DB tables do not have likes_count column
        let { error } = await supabase.from('comments').insert([{
            post_id: postId,
            author_id: tgUser.id.toString(),
            author_name: authorName,
            text,
            content_type: contentType
        }]);
        if (error) {
            console.error("addComment (with content_type) failed, retrying without it:", error.message || error);
            // Fall back for DBs that haven't run shorts_migration.sql yet (no content_type column)
            const retry = await supabase.from('comments').insert([{
                post_id: postId,
                author_id: tgUser.id.toString(),
                author_name: authorName,
                text
            }]);
            if (retry.error) throw retry.error;
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
        }

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
    await supabase.from('comments').delete().match({ id: commentId, author_id: tgUser.id.toString() });
    res.json({ success: true });
});

// ================= SHORTS VIDEO APIs =================
// Videos are never stored in Supabase directly — only Telegram's file_id is kept.
// User uploads go through a dedicated storage channel (STORAGE_CHANNEL_ID); channel
// videos are auto-synced straight from the origin channel_post (see bot.on('channel_post')).

async function enrichVideos(videos) {
    if (!videos) return [];
    return Promise.all(videos.map(async v => {
        let authPhoto = `https://ui-avatars.com/api/?name=${encodeURIComponent(v.author_name || 'U')}`;
        let authorLevel = 1;
        let authorUsername = '';
        let authorVerified = false;

        try {
            if (v.type === 'user') {
                const { data: u } = await supabase.from('users').select('photo_url, username, is_verified').eq('tg_id', v.author_id).maybeSingle();
                if (u) {
                    if (u.photo_url) authPhoto = u.photo_url;
                    if (u.username) authorUsername = u.username;
                    authorVerified = !!u.is_verified;
                }
                const { count: refCount } = await supabase.from('users').select('*', { count: 'exact', head: true }).eq('referred_by', v.author_id);
                authorLevel = authorVerified ? 3 : getLevelData(refCount || 0).level;
            } else if (v.type === 'channel') {
                const { data: u } = await supabase.from('users').select('channels, is_verified').contains('channels', [{ id: v.author_id }]);
                if (u && u.length > 0) {
                    const owner = u[0];
                    const ch = owner.channels.find(c => String(c.id) === String(v.author_id));
                    if (ch) {
                        if (ch.photo) authPhoto = ch.photo;
                        if (ch.username) authorUsername = ch.username;
                        authorVerified = !!ch.verified || !!owner.is_verified;
                    }
                }
            }
        } catch (e) {}

        return {
            ...v,
            author_photo: authPhoto,
            author_level: authorLevel,
            author_username: authorUsername,
            author_verified: authorVerified,
            stream_url: `/api/videoStream/${v.id}`
        };
    }));
}

// Paginated Shorts feed
app.post('/api/getShorts', async (req, res) => {
    const { page = 1, limit = 5 } = req.body;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    try {
        const { data: videos, error } = await supabase.from('videos')
            .select('*')
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
app.get('/api/videoStream/:id', async (req, res) => {
    try {
        const { data: video } = await supabase.from('videos').select('file_id').eq('id', req.params.id).maybeSingle();
        if (!video) return res.status(404).send("Video not found");
        const link = await bot.telegram.getFileLink(video.file_id);
        res.redirect(link.href || link.toString());
    } catch (e) {
        res.status(500).send("Could not resolve video stream");
    }
});

// Upload a new video (users only — channels are captured automatically via channel_post)
app.post('/api/createVideo', async (req, res) => {
    const { initData, caption, videoBase64 } = req.body;
    const tgUser = validateTGData(initData);
    if (!tgUser) return res.status(403).json({ error: "Unauthorized" });
    if (!videoBase64) return res.status(400).json({ error: "No video provided" });
    if (!STORAGE_CHANNEL_ID) return res.status(500).json({ error: "Server is missing STORAGE_CHANNEL_ID configuration" });

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
            storage_chat_id: STORAGE_CHANNEL_ID,
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
        const { data: video, error: fetchErr } = await supabase.from('videos').select('likes_count, likes_users, author_id, caption, type').eq('id', videoId).maybeSingle();
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
        }

        await supabase.from('videos').update({ likes_count: likesCount, likes_users: likesUsers }).eq('id', videoId);
        res.json({ success: true, likesCount, hasLiked });
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

        const { error } = await supabase.from('reports').insert([{
            post_id: videoId,
            post_author_id: video.author_id,
            post_type: video.type,
            content_type: 'video',
            reporter_id: tgUser.id.toString(),
            reason: reason || 'Not specified',
            created_at: new Date().toISOString()
        }]);
        if (error) throw error;
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
            const { data: posts } = await supabase.from('posts').select('id, text, image_urls').in('id', postEntries.map(g => g.post_id));
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
    const { data: owners } = await supabase.from('users').select('tg_id, channels').contains('channels', [{ id: channelId.toString() }]);
    for (const owner of (owners || [])) {
        const updated = (owner.channels || []).filter(c => String(c.id) !== String(channelId));
        await supabase.from('users').update({ channels: updated }).eq('tg_id', owner.tg_id);
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

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'indexadmin.html')));
app.use(bot.webhookCallback('/webhook'));
app.listen(process.env.PORT || 3000, async () => {
    console.log("Server Live!");
    await bot.telegram.setWebhook(`${process.env.RENDER_EXTERNAL_URL}/webhook`);
});
