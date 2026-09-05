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
const IMGBB_API = process.env.IMGBB_API_KEY || "348c88ef05445299a559f02b83ace6bbbb";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme";

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

// Extra guard: the calling Telegram user must also be flagged is_admin in DB.
async function requireAdminUser(req, res, next) {
    try {
        const tgUser = validateTGData(req.body.initData);
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
        let cleanBase64 = base64Str;
        if (base64Str.includes(',')) {
            cleanBase64 = base64Str.split(',')[1];
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

        await supabase.from('users').insert([{
            tg_id: tgId,
            name: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || "Telegram User",
            username: ctx.from.username || '',
            photo_url,
            referred_by,
            channels: [],
            is_verified: false,
            is_admin: false
        }]);
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
async function enforcePostCap(cap = 500) {
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

// ================= APIs =================

// Public: lets the frontend know if the app is in maintenance mode before doing anything else
app.get('/api/appStatus', async (req, res) => {
    const maintenance = await isMaintenanceMode();
    res.json({ maintenance });
});

app.post('/api/auth', async (req, res) => {
    const tgUser = validateTGData(req.body.initData);
    if (!tgUser) return res.status(403).json({ error: "Unauthorized" });

    const tgId = tgUser.id.toString();

    const { data: banned } = await supabase.from('banned_users').select('tg_id').eq('tg_id', tgId).maybeSingle();
    if (banned) return res.status(403).json({ error: "banned" });

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

        const { data: newUser } = await supabase.from('users').insert([{
            tg_id: tgId,
            name: [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ') || "User",
            photo_url,
            referred_by,
            channels: [],
            is_verified: false,
            is_admin: false
        }]).select().single();
        user = newUser;
    } else if (!user.photo_url || user.photo_url.includes('ui-avatars')) {
        const photo_url = await getTgProfilePic(tgId);
        const { data: updated } = await supabase.from('users').update({ photo_url }).eq('tg_id', tgId).select().single();
        user = updated;
    }

    const { count: refCount } = await supabase.from('users').select('*', { count: 'exact', head: true }).eq('referred_by', tgId);
    user.ref_count = refCount || 0;
    // Verified (blue badge) users are unlocked to the top level regardless of referrals
    user.level = user.is_verified ? 3 : getLevelData(refCount || 0).level;

    res.json({ success: true, user });
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
                const { data: u } = await supabase.from('users').select('channels').contains('channels', [{ id: post.author_id }]);
                if (u && u.length > 0) {
                    const ch = u[0].channels.find(c => String(c.id) === String(post.author_id));
                    if (ch) {
                        if (ch.photo) authPhoto = ch.photo;
                        if (ch.username) authorUsername = ch.username;
                        authorVerified = !!ch.verified;
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
        const { data: user } = await supabase.from('users').select('*').eq('tg_id', tgUser.id).single();

        let imageUrls = [];
        if (imagesBase64 && imagesBase64.length > 0) {
            for (let img of imagesBase64) {
                const uploadedUrl = await uploadImageToImgBB(img);
                if (uploadedUrl) imageUrls.push(uploadedUrl);
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
        res.json({ success: true });
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
        await supabase.from('reports').delete().eq('post_id', postId);
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
            chatId = input; // Raw Numerical ID
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

        const { data: user } = await supabase.from('users').select('*').eq('tg_id', tgUser.id).single();
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
        await supabase.from('users').update({ channels }).eq('tg_id', tgUser.id);

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
    const { data: user } = await supabase.from('users').select('channels').eq('tg_id', tgUser.id).single();
    let channels = user.channels.filter(c => c.id !== channelId);
    await supabase.from('users').update({ channels }).eq('tg_id', tgUser.id);
    res.json({ success: true, channels });
});

// Secure Search Posts API (Bypassing direct client-side RLS Blockage)
app.post('/api/searchPosts', async (req, res) => {
    const { query } = req.body;
    try {
        const { data, error } = await supabase.from('posts').select('*').ilike('text', `%${query}%`).limit(15);
        if (error) throw error;
        res.json(await enrichPosts(data || []));
    } catch (e) {
        res.status(500).json({ error: e.message || e });
    }
});

// Comments API
app.post('/api/getComments', async (req, res) => {
    const { postId } = req.body;
    const { data } = await supabase.from('comments').select('*').eq('post_id', postId).order('created_at', { ascending: true });
    res.json(data);
});

app.post('/api/addComment', async (req, res) => {
    const { initData, postId, text } = req.body;
    const tgUser = validateTGData(initData);
    if (!tgUser) return res.status(403).json({ error: "Unauthorized" });

    try {
        const { data: user } = await supabase.from('users').select('name').eq('tg_id', tgUser.id.toString()).maybeSingle();
        const authorName = user ? user.name : tgUser.first_name || "Anonymous";

        // FIXED: Removed likes_count parameter to prevent crash if old DB tables do not have likes_count column
        const { error } = await supabase.from('comments').insert([{
            post_id: postId,
            author_id: tgUser.id.toString(),
            author_name: authorName,
            text
        }]);
        if (error) throw error;

        // Send Bot notification to post author or channel owners about comment
        const { data: post } = await supabase.from('posts').select('author_id, text, type').eq('id', postId).maybeSingle();
        if (post && String(post.author_id) !== tgUser.id.toString()) {
            const postPreview = post.text ? post.text.substring(0, 20) : 'Photo Post';
            await notifyPostOwners(
                post.author_id,
                post.type,
                `💬 ${tgUser.first_name} commented on your post:\n"${postPreview}..."\n\nComment: "${text}"`,
                `post_${postId}`
            );
        }

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message || e });
    }
});

app.post('/api/deleteComment', async (req, res) => {
    const { initData, commentId } = req.body;
    const tgUser = validateTGData(initData);
    await supabase.from('comments').delete().match({ id: commentId, author_id: tgUser.id.toString() });
    res.json({ success: true });
});

// ================= ADMIN PANEL APIs =================
// All routes below require the caller to (a) be flagged is_admin in the users table AND
// (b) supply the correct adminPassword (set via the ADMIN_PASSWORD env var on Render).

app.post('/api/admin/login', requireAdminUser, requireAdminPassword, async (req, res) => {
    res.json({ success: true });
});

app.post('/api/admin/dashboard', requireAdminUser, requireAdminPassword, async (req, res) => {
    try {
        const { count: totalUsers } = await supabase.from('users').select('*', { count: 'exact', head: true });
        const { count: totalPosts } = await supabase.from('posts').select('*', { count: 'exact', head: true });
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

        // Group reports by post
        const grouped = {};
        (reports || []).forEach(r => {
            if (!grouped[r.post_id]) grouped[r.post_id] = { post_id: r.post_id, post_author_id: r.post_author_id, post_type: r.post_type, reasons: [], count: 0 };
            grouped[r.post_id].count++;
            grouped[r.post_id].reasons.push(r.reason);
        });

        const postIds = Object.keys(grouped);
        if (postIds.length > 0) {
            const { data: posts } = await supabase.from('posts').select('id, text, image_urls').in('id', postIds);
            (posts || []).forEach(p => {
                if (grouped[p.id]) {
                    grouped[p.id].post_text = p.text;
                    grouped[p.id].post_link = `${process.env.MINI_APP_URL}?startapp=post_${p.id}`;
                }
            });
        }

        res.json(Object.values(grouped));
    } catch (e) {
        res.status(500).json({ error: e.message || e });
    }
});

app.post('/api/admin/removePost', requireAdminUser, requireAdminPassword, async (req, res) => {
    const { postId } = req.body;
    try {
        await supabase.from('posts').delete().eq('id', postId);
        await supabase.from('reports').delete().eq('post_id', postId);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message || e }); }
});

app.post('/api/admin/removePostBanUser', requireAdminUser, requireAdminPassword, async (req, res) => {
    const { postId } = req.body;
    try {
        const { data: post } = await supabase.from('posts').select('*').eq('id', postId).maybeSingle();
        if (!post) return res.status(404).json({ error: "Post not found" });

        if (post.type === 'channel') {
            // Ban the channel instead of a user
            await banChannelInternal(post.author_id);
        } else {
            await banUserInternal(post.author_id);
        }

        await supabase.from('posts').delete().eq('id', postId);
        await supabase.from('reports').delete().eq('post_id', postId);
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

async function banUserInternal(tgId) {
    await supabase.from('banned_users').upsert([{ tg_id: tgId.toString(), banned_at: new Date().toISOString() }]);
    await supabase.from('posts').delete().eq('author_id', tgId.toString());
    await supabase.from('comments').delete().eq('author_id', tgId.toString());
    await supabase.from('users').delete().eq('tg_id', tgId.toString());
}

async function banChannelInternal(channelId) {
    await supabase.from('banned_channels').upsert([{ channel_id: channelId.toString(), banned_at: new Date().toISOString() }]);
    await supabase.from('posts').delete().eq('author_id', channelId.toString());
    // strip the channel out of every user's channels array
    const { data: owners } = await supabase.from('users').select('tg_id, channels').contains('channels', [{ id: channelId.toString() }]);
    for (const owner of (owners || [])) {
        const updated = (owner.channels || []).filter(c => String(c.id) !== String(channelId));
        await supabase.from('users').update({ channels: updated }).eq('tg_id', owner.tg_id);
    }
}

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
            const { data: owners } = await supabase.from('users').select('tg_id, channels').contains('channels', [{ id: targetId.toString() }]);
            for (const owner of (owners || [])) {
                const updated = (owner.channels || []).map(c => String(c.id) === String(targetId) ? { ...c, verified } : c);
                await supabase.from('users').update({ channels: updated }).eq('tg_id', owner.tg_id);
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
            const { error } = await query;
            if (error) throw error;
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

app.post('/api/admin/wipeDatabase', requireAdminUser, requireAdminPassword, async (req, res) => {
    const { confirm } = req.body;
    if (confirm !== 'WIPE') return res.status(400).json({ error: "Confirmation phrase mismatch" });
    try {
        await supabase.from('comments').delete().neq('id', 0);
        await supabase.from('reports').delete().neq('id', 0);
        await supabase.from('posts').delete().neq('id', 0);
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
