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
// ছবি আপলোডের জন্য লিমিট ৫০MB করা হয়েছে
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ==========================================
// 1. Initializations
// ==========================================
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const bot = new Telegraf(process.env.BOT_TOKEN);
const IMGBB_API = process.env.IMGBB_API_KEY;

// ==========================================
// 2. Helper Functions
// ==========================================
// Level & Post Limit Logic
const getLevelData = (referrals) => {
    if (referrals >= 10) return { level: 5, limit: 999, channels: 5 };
    if (referrals >= 8) return { level: 4, limit: 9, channels: 1 };
    if (referrals >= 6) return { level: 3, limit: 7, channels: 1 };
    if (referrals >= 4) return { level: 2, limit: 4, channels: 1 };
    return { level: 1, limit: 2, channels: 1 };
};

// Telegram WebApp initData Validator (Security)
const validateTGData = (initData) => {
    try {
        const urlParams = new URLSearchParams(initData);
        const hash = urlParams.get('hash');
        urlParams.delete('hash');
        urlParams.sort();
        let dataCheckString = '';
        for (const [key, value] of urlParams.entries()) {
            dataCheckString += `${key}=${value}\n`;
        }
        const secret = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN).digest();
        const calcHash = crypto.createHmac('sha256', secret).update(dataCheckString.slice(0, -1)).digest('hex');
        
        if (calcHash !== hash) return null;
        return JSON.parse(urlParams.get('user'));
    } catch (e) {
        return null;
    }
};

// Push Notification Logic
async function sendNotification(targetUserId, message, postId) {
    const { data: user } = await supabase.from('users').select('push_notif').eq('tg_id', targetUserId).single();
    if (user && user.push_notif) {
        bot.telegram.sendMessage(targetUserId, message, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[ { text: 'Check Post 👀', web_app: { url: `${process.env.MINI_APP_URL}?startapp=post_${postId}` } } ]]
            }
        }).catch(e => console.log("Bot blocked by user"));
    }
}

// ==========================================
// 3. Telegram Bot Commands (/start & Webhooks)
// ==========================================
bot.start(async (ctx) => {
    const tgId = ctx.from.id.toString();
    const referId = ctx.message.text.split(' ')[1]; // Extract referral ID

    const { data: user } = await supabase.from('users').select('*').eq('tg_id', tgId).single();

    if (!user) {
        // New User -> Save to DB
        await supabase.from('users').insert([{ 
            tg_id: tgId, name: ctx.from.first_name, username: ctx.from.username || '', photo_url: '' 
        }]);

        // Referral Check & Increment
        if (referId && referId !== tgId) {
            const { data: refUser } = await supabase.from('users').select('refer_count').eq('tg_id', referId).single();
            if (refUser) {
                const newCount = refUser.refer_count + 1;
                const { level } = getLevelData(newCount);
                await supabase.from('users').update({ refer_count: newCount, level }).eq('tg_id', referId);
                bot.telegram.sendMessage(referId, `🎉 **${ctx.from.first_name}** joined via your link! You now have ${newCount} referrals.`, { parse_mode: 'Markdown' });
            }
        }
    }
    
    ctx.reply('Welcome to the Ultimate Mini App! 🚀', Markup.inlineKeyboard([
        Markup.button.webApp('Launch App', process.env.MINI_APP_URL)
    ]));
});

// Auto Channel Post Syncing
bot.on('channel_post', async (ctx) => {
    const channelId = ctx.update.channel_post.chat.id.toString();
    const msg = ctx.update.channel_post;

    // Verify if channel is added by a user
    const { data: users } = await supabase.from('users').select('tg_id').contains('added_channels', [channelId]);
    if (!users || users.length === 0) return;

    if (msg.photo) {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        const fileLink = await ctx.telegram.getFileLink(fileId);
        
        try {
            // 1. Upload to ImgBB
            const imgbb = await axios.post(`https://api.imgbb.com/1/upload?key=${IMGBB_API}&image=${encodeURIComponent(fileLink)}`);
            const imageUrl = imgbb.data.data.url;

            // 2. Save to Supabase
            const { data: post } = await supabase.from('posts').insert([{
                author_id: channelId, author_name: msg.chat.title, type: 'channel',
                text: msg.caption || '', image_url: imageUrl
            }]).select();

            // 3. Notify Followers
            const { data: follows } = await supabase.from('follows').select('follower_id').eq('following_id', channelId);
            follows?.forEach(async (f) => {
                sendNotification(f.follower_id, `🔔 **${msg.chat.title}** posted a new update!`, post[0].id);
            });
        } catch (e) { console.error("Channel Sync Error:", e); }
    }
});


// ==========================================
// 4. API Routes (Frontend <-> Backend)
// ==========================================

// Auth & Auto-Welcome Route
app.post('/api/auth', async (req, res) => {
    const { initData } = req.body;
    const tgUser = validateTGData(initData);
    
    if (!tgUser) return res.status(403).json({ error: "Unauthorized / Fake Request" });

    const tgId = tgUser.id.toString();
    const { data: user } = await supabase.from('users').select('*').eq('tg_id', tgId).single();

    if (!user) {
        // Auto Account Create for Direct Links
        await supabase.from('users').insert([{ 
            tg_id: tgId, name: tgUser.first_name, username: tgUser.username || '' 
        }]);
        
        // Send Auto Welcome DM
        bot.telegram.sendMessage(tgId, `👋 Hello ${tgUser.first_name}, Welcome to our App!`, {
            reply_markup: { inline_keyboard: [[ { text: 'Open App', web_app: { url: process.env.MINI_APP_URL } } ]] }
        }).catch(e => console.log("Can't send welcome message"));
    }
    
    res.json({ success: true, user: user || tgUser });
});


// Create Post Route
app.post('/api/createPost', async (req, res) => {
    const { initData, text, imageBase64 } = req.body;
    const tgUser = validateTGData(initData);
    if (!tgUser) return res.status(403).json({ error: "Unauthorized" });

    const tgId = tgUser.id.toString();
    const { data: user } = await supabase.from('users').select('*').eq('tg_id', tgId).single();
    
    // Check Limits
    const limits = getLevelData(user.refer_count);
    const today = new Date().toISOString().split('T')[0];
    const { count } = await supabase.from('posts').select('*', { count: 'exact' }).eq('author_id', tgId).gte('created_at', today);

    if (count >= limits.limit) {
        return res.status(400).json({ error: `Daily limit of ${limits.limit} posts reached.` });
    }

    let imageUrl = '';
    if (imageBase64) {
        try {
            const form = new URLSearchParams();
            form.append('image', imageBase64.split(',')[1]); 
            const imgbb = await axios.post(`https://api.imgbb.com/1/upload?key=${IMGBB_API}`, form);
            imageUrl = imgbb.data.data.url;
        } catch(e) { return res.status(500).json({ error: "Image Upload Failed" }); }
    }

    await supabase.from('posts').insert([{ author_id: tgId, author_name: user.name, type: 'user', text, image_url: imageUrl }]);
    res.json({ success: true });
});

// Interact API (Like, Follow)
app.post('/api/interact', async (req, res) => {
    const { initData, postId, action, targetUserId } = req.body;
    const tgUser = validateTGData(initData);
    if (!tgUser) return res.status(403).json({ error: "Unauthorized" });

    const userId = tgUser.id.toString();

    if (action === 'like') {
        const { data: post } = await supabase.from('posts').select('likes').eq('id', postId).single();
        let likes = post.likes || [];
        if (!likes.includes(userId)) {
            likes.push(userId);
            await supabase.from('posts').update({ likes }).eq('id', postId);
            if(userId !== targetUserId) sendNotification(targetUserId, `❤️ **${tgUser.first_name}** liked your post!`, postId);
        } else {
            likes = likes.filter(id => id !== userId);
            await supabase.from('posts').update({ likes }).eq('id', postId);
        }
        res.json({ success: true, likes: likes.length });
    }
});

// Update Settings API
app.post('/api/updateSettings', async (req, res) => {
    const { initData, push_notif, lang } = req.body;
    const tgUser = validateTGData(initData);
    if (!tgUser) return res.status(403).json({ error: "Unauthorized" });

    await supabase.from('users').update({ push_notif }).eq('tg_id', tgUser.id.toString());
    res.json({ success: true });
});

// ==========================================
// 5. Serve Frontend (index.html)
// ==========================================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ==========================================
// 6. Start Server & Webhook
// ==========================================
app.use(bot.webhookCallback('/webhook'));

app.listen(process.env.PORT || 3000, async () => {
    console.log("Server Live and Listening...");
    try {
        await bot.telegram.setWebhook(`${process.env.RENDER_EXTERNAL_URL}/webhook`);
        console.log("Webhook Set Successfully!");
    } catch(e) {
        console.error("Failed to set webhook:", e);
    }
});
