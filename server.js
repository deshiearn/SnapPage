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
const IMGBB_API = process.env.IMGBB_API_KEY || "348c88ef05445299a559f02b83ace6bbbb"; // Updated live ImgBB API key

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
        // Appends startapp query param to allow targeted deep-linking on open app
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

// ================= Bot Commands =================
bot.start(async (ctx) => {
    const tgId = ctx.from.id.toString();
    const payload = ctx.startPayload || "";
    
    let { data: user } = await supabase.from('users').select('*').eq('tg_id', tgId).maybeSingle();

    if (!user) {
        const photo_url = await getTgProfilePic(tgId);
        let referred_by = null;
        if (payload.startsWith("ref_")) {
            referred_by = payload.replace("ref_", "");
            
            // Notify the inviter that someone joined using their link
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
            channels: []
        }]);
    }
    ctx.reply('Welcome to SnapPages! 🚀', Markup.inlineKeyboard([ Markup.button.webApp('Open App', process.env.MINI_APP_URL) ]));
});

// ================= Channel Auto Sync =================
bot.on('channel_post', async (ctx) => {
    const channelId = ctx.update.channel_post.chat.id.toString();
    const msg = ctx.update.channel_post;
    
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
                created_at: new Date().toISOString()
            }]);
        } catch (e) { 
            console.error("Auto Sync Sync Error", e); 
        }
    }
});

// ================= APIs =================

app.post('/api/auth', async (req, res) => {
    const tgUser = validateTGData(req.body.initData);
    if (!tgUser) return res.status(403).json({ error: "Unauthorized" });

    const tgId = tgUser.id.toString();
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
            channels: []
        }]).select().single();
        user = newUser;
    } else if (!user.photo_url || user.photo_url.includes('ui-avatars')) {
        const photo_url = await getTgProfilePic(tgId);
        const { data: updated } = await supabase.from('users').update({ photo_url }).eq('tg_id', tgId).select().single();
        user = updated;
    }

    const { count: refCount } = await supabase.from('users').select('*', { count: 'exact', head: true }).eq('referred_by', tgId);
    user.ref_count = refCount || 0;
    user.level = getLevelData(refCount || 0).level;

    res.json({ success: true, user });
});

// Secure endpoint to get all Posts with Pagination and author data mapping
app.post('/api/getPosts', async (req, res) => {
    const { page = 1, limit = 10 } = req.body;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    try {
        const { data: posts, error } = await supabase.from('posts')
            .select('*')
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (error) throw error;
        if (!posts) return res.json([]);

        // Fetch & enrich author details for all retrieved posts
        const enrichedPosts = await Promise.all(posts.map(async post => {
            let authPhoto = `https://ui-avatars.com/api/?name=${encodeURIComponent(post.author_name || 'U')}`;
            let authorLevel = 1;
            let authorUsername = '';

            try {
                if (post.type === 'user') {
                    const { data: u } = await supabase.from('users').select('photo_url, username, tg_id').eq('tg_id', post.author_id).maybeSingle();
                    if (u) {
                        if (u.photo_url) authPhoto = u.photo_url;
                        if (u.username) authorUsername = u.username;
                    }

                    const { count: refCount } = await supabase.from('users').select('*', { count: 'exact', head: true }).eq('referred_by', post.author_id);
                    authorLevel = getLevelData(refCount || 0).level;
                } else if (post.type === 'channel') {
                    const { data: u } = await supabase.from('users').select('channels').contains('channels', [{ id: post.author_id }]);
                    if (u && u.length > 0) {
                        const ch = u[0].channels.find(c => String(c.id) === String(post.author_id));
                        if (ch) {
                            if (ch.photo) authPhoto = ch.photo;
                            if (ch.username) authorUsername = ch.username;
                        }
                    }
                }
            } catch(e) {}

            return {
                ...post,
                author_photo: authPhoto,
                author_level: authorLevel,
                author_username: authorUsername
            };
        }));

        res.json(enrichedPosts);
    } catch (e) {
        console.error("Feed error:", e);
        res.json([]); // Return empty list instead of crashing client side
    }
});

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
            created_at: new Date().toISOString()
        }]);

        if (error) throw error;
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message || e });
    }
});

// Edit Post
app.post('/api/editPost', async (req, res) => {
    const { initData, postId, text, imageUrls } = req.body;
    const tgUser = validateTGData(initData);
    if (!tgUser) return res.status(403).json({ error: "Unauthorized" });

    try {
        const { error } = await supabase.from('posts').update({
            text,
            image_urls: imageUrls
        }).match({ id: postId, author_id: tgUser.id.toString() });
        
        if (error) throw error;
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message || e });
    }
});

// Delete Post
app.post('/api/deletePost', async (req, res) => {
    const { initData, postId } = req.body;
    const tgUser = validateTGData(initData);
    if (!tgUser) return res.status(403).json({ error: "Unauthorized" });

    try {
        const { error } = await supabase.from('posts').delete().match({ id: postId, author_id: tgUser.id.toString() });
        if (error) throw error;
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message || e });
    }
});

// Like/Unlike dynamic handler with bot notifications
app.post('/api/likePost', async (req, res) => {
    const { initData, postId } = req.body;
    const tgUser = validateTGData(initData);
    if (!tgUser) return res.status(403).json({ error: "Unauthorized" });

    try {
        const { data: post, error: fetchErr } = await supabase.from('posts').select('likes_count, likes_users, author_id, text').eq('id', postId).maybeSingle();
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

                // Send Bot Notification to the post owner (if it's not the owner themselves)
                if (String(post.author_id) !== userId) {
                    const postPreview = post.text ? post.text.substring(0, 30) : 'Photo Post';
                    sendTelegramNotification(
                        post.author_id, 
                        `❤️ ${tgUser.first_name} liked your post:\n"${postPreview}..."`, 
                        `post_${postId}`
                    );
                }
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
        
        // Verification: Check if Bot is Admin
        const botInfo = await bot.telegram.getMe();
        const member = await bot.telegram.getChatMember(chat.id, botInfo.id);
        if (member.status !== 'administrator') {
            return res.json({ error: "Bot is not an admin inside this channel!" });
        }

        // Query dynamic refer count to check Limit eligibility
        const { count: refs } = await supabase.from('users').select('*', { count: 'exact', head: true }).eq('referred_by', tgUser.id.toString());
        const limits = getLevelData(refs || 0);

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
        channels.push({ id: chat.id.toString(), name: chat.title, username: cleanUsername, photo: photoUrl });
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
        
        const { error } = await supabase.from('comments').insert([{ 
            post_id: postId, 
            author_id: tgUser.id.toString(), 
            author_name: authorName, 
            text,
            likes_count: 0
        }]);
        if (error) throw error;

        // Send Bot notification to post author about comment
        const { data: post } = await supabase.from('posts').select('author_id, text').eq('id', postId).maybeSingle();
        if (post && String(post.author_id) !== tgUser.id.toString()) {
            const postPreview = post.text ? post.text.substring(0, 20) : 'Photo Post';
            sendTelegramNotification(
                post.author_id, 
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

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use(bot.webhookCallback('/webhook'));
app.listen(process.env.PORT || 3000, async () => {
    console.log("Server Live!");
    await bot.telegram.setWebhook(`${process.env.RENDER_EXTERNAL_URL}/webhook`);
});
