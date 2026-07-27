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
const IMGBB_API = process.env.IMGBB_API_KEY;

// ================= Referral Level Mapping (3 Refs = Lvl 2, 5 Refs = Lvl 3) =================
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

// ================= Auto Fetch Telegram Profile Photo =================
async function getTgProfilePic(tgId) {
    try {
        const photos = await bot.telegram.getUserProfilePhotos(tgId, 0, 1);
        if (photos.total_count > 0) {
            const fileId = photos.photos[0][0].file_id;
            const link = await bot.telegram.getFileLink(fileId);
            const imgbb = await axios.post(`https://api.imgbb.com/1/upload?key=${IMGBB_API}&image=${encodeURIComponent(link)}`);
            return imgbb.data.data.url;
        }
    } catch (e) { console.log("Photo fetch failed"); }
    return "https://ui-avatars.com/api/?name=User&background=random";
}

// ================= Bot Commands =================
bot.start(async (ctx) => {
    const tgId = ctx.from.id.toString();
    const payload = ctx.startPayload || ""; // Telegram passes start_param here automatically
    
    let { data: user } = await supabase.from('users').select('*').eq('tg_id', tgId).maybeSingle();

    if (!user) {
        const photo_url = await getTgProfilePic(tgId);
        let referred_by = null;
        if (payload.startsWith("ref_")) {
            referred_by = payload.replace("ref_", "");
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
    
    const { data: users } = await supabase.from('users').select('channels');
    let isRegistered = false;
    users?.forEach(u => { if(u.channels?.some(c => c.id === channelId)) isRegistered = true; });

    if (isRegistered && msg.photo) {
        try {
            const fileLink = await bot.telegram.getFileLink(msg.photo[msg.photo.length - 1].file_id);
            const imgbb = await axios.post(`https://api.imgbb.com/1/upload?key=${IMGBB_API}&image=${encodeURIComponent(fileLink)}`);
            
            await supabase.from('posts').insert([{
                author_id: channelId, 
                author_name: msg.chat.title, 
                type: 'channel',
                text: msg.caption || '', 
                image_urls: [imgbb.data.data.url]
            }]);
        } catch (e) { console.error("Sync Error", e); }
    }
});

// ================= APIs =================

app.post('/api/auth', async (req, res) => {
    const tgUser = validateTGData(req.body.initData);
    if (!tgUser) return res.status(403).json({ error: "Unauthorized" });

    const tgId = tgUser.id.toString();
    
    // Extract referral from raw initData safely if present
    const urlParams = new URLSearchParams(req.body.initData);
    const startParam = urlParams.get('start_param') || '';

    let { data: user } = await supabase.from('users').select('*').eq('tg_id', tgId).maybeSingle();

    if (!user) {
        const photo_url = await getTgProfilePic(tgId);
        let referred_by = null;
        if (startParam.startsWith("ref_")) {
            referred_by = startParam.replace("ref_", "");
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
    res.json({ success: true, user });
});

// Create Post (Up to 4 Images)
app.post('/api/createPost', async (req, res) => {
    const { initData, text, imagesBase64 } = req.body;
    const tgUser = validateTGData(initData);
    if (!tgUser) return res.status(403).json({ error: "Unauthorized" });

    const { data: user } = await supabase.from('users').select('*').eq('tg_id', tgUser.id).single();
    
    let imageUrls = [];
    if (imagesBase64 && imagesBase64.length > 0) {
        for (let img of imagesBase64) {
            try {
                const form = new URLSearchParams();
                form.append('image', img.split(',')[1]);
                const imgbb = await axios.post(`https://api.imgbb.com/1/upload?key=${IMGBB_API}`, form);
                imageUrls.push(imgbb.data.data.url);
            } catch(e) {}
        }
    }

    await supabase.from('posts').insert([{ 
        author_id: tgUser.id.toString(), 
        author_name: user.name, 
        type: 'user', 
        text, 
        image_urls: imageUrls,
        created_at: new Date().toISOString()
    }]);
    res.json({ success: true });
});

// Setup Channel
app.post('/api/addChannel', async (req, res) => {
    const { initData, channelInput } = req.body;
    const tgUser = validateTGData(initData);
    if (!tgUser) return res.status(403).json({ error: "Unauthorized" });

    try {
        let username = channelInput.replace('https://t.me/', '').replace('@', '');
        const chat = await bot.telegram.getChat(`@${username}`);
        
        // Verification: Check if Bot is Admin
        const botInfo = await bot.telegram.getMe();
        const member = await bot.telegram.getChatMember(chat.id, botInfo.id);
        if (member.status !== 'administrator') return res.json({ error: "Bot is not an admin in this channel!" });

        // Query dynamic refer count to check Limit eligibility
        const { count: refs } = await supabase.from('users').select('*', { count: 'exact', head: true }).eq('referred_by', tgUser.id.toString());
        const limits = getLevelData(refs || 0);

        const { data: user } = await supabase.from('users').select('*').eq('tg_id', tgUser.id).single();
        let channels = user.channels || [];
        if (channels.length >= limits.channels) {
            return res.json({ error: `At your Level (Level ${limits.level}), you can only set up to ${limits.channels} channel(s).` });
        }

        // Get Channel Photo
        let photoUrl = 'https://ui-avatars.com/api/?name=Channel';
        if (chat.photo) {
            const link = await bot.telegram.getFileLink(chat.photo.small_file_id);
            const imgbb = await axios.post(`https://api.imgbb.com/1/upload?key=${IMGBB_API}&image=${encodeURIComponent(link)}`);
            photoUrl = imgbb.data.data.url;
        }

        channels.push({ id: chat.id.toString(), name: chat.title, username, photo: photoUrl });
        await supabase.from('users').update({ channels }).eq('tg_id', tgUser.id);
        res.json({ success: true, channels });

    } catch (e) { res.json({ error: "Invalid Channel setup or bot doesn't have privileges!" }); }
});

app.post('/api/removeChannel', async (req, res) => {
    const { initData, channelId } = req.body;
    const tgUser = validateTGData(initData);
    const { data: user } = await supabase.from('users').select('channels').eq('tg_id', tgUser.id).single();
    let channels = user.channels.filter(c => c.id !== channelId);
    await supabase.from('users').update({ channels }).eq('tg_id', tgUser.id);
    res.json({ success: true, channels });
});

// Post Management (Delete)
app.post('/api/deletePost', async (req, res) => {
    const { initData, postId } = req.body;
    const tgUser = validateTGData(initData);
    await supabase.from('posts').delete().match({ id: postId, author_id: tgUser.id.toString() });
    res.json({ success: true });
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
    const { data: user } = await supabase.from('users').select('name').eq('tg_id', tgUser.id).single();
    await supabase.from('comments').insert([{ 
        post_id: postId, 
        author_id: tgUser.id.toString(), 
        author_name: user.name, 
        text,
        likes_count: 0
    }]);
    res.json({ success: true });
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
