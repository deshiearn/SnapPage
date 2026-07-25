require('dotenv').config();
const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' })); // Image upload-এর জন্য

// Supabase & Bot Init
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const bot = new Telegraf(process.env.BOT_TOKEN);
const IMGBB_API = process.env.IMGBB_API_KEY;

// ==========================================
// 1. Level & Limit Helper Logic
// ==========================================
const getLevelData = (referrals) => {
    if (referrals >= 10) return { level: 5, limit: 999, channels: 5 };
    if (referrals >= 8) return { level: 4, limit: 9, channels: 1 };
    if (referrals >= 6) return { level: 3, limit: 7, channels: 1 };
    if (referrals >= 4) return { level: 2, limit: 4, channels: 1 };
    return { level: 1, limit: 2, channels: 1 };
};

// ==========================================
// 2. Bot /start & Referral System
// ==========================================
bot.start(async (ctx) => {
    const tgId = ctx.from.id.toString();
    const referId = ctx.message.text.split(' ')[1];

    const { data: user } = await supabase.from('users').select('*').eq('tg_id', tgId).single();

    if (!user) {
        // Create User
        await supabase.from('users').insert([{ 
            tg_id: tgId, name: ctx.from.first_name, username: ctx.from.username || '' 
        }]);

        // Add Referral Logic
        if (referId && referId !== tgId) {
            const { data: refUser } = await supabase.from('users').select('refer_count').eq('tg_id', referId).single();
            if (refUser) {
                const newCount = refUser.refer_count + 1;
                const { level } = getLevelData(newCount);
                await supabase.from('users').update({ refer_count: newCount, level }).eq('tg_id', referId);
                bot.telegram.sendMessage(referId, `🎉 Someone joined via your link! You now have ${newCount} referrals.`);
            }
        }
    }
    // Welcome Message
    ctx.reply('Welcome to the Ultimate Mini App! 🚀', Markup.inlineKeyboard([
        Markup.button.webApp('Launch App', process.env.MINI_APP_URL)
    ]));
});

// ==========================================
// 3. Auto Channel Sync to Supabase & ImgBB
// ==========================================
bot.on('channel_post', async (ctx) => {
    const channelId = ctx.update.channel_post.chat.id.toString();
    const msg = ctx.update.channel_post;

    // Check if channel is registered
    const { data: users } = await supabase.from('users').select('tg_id').contains('added_channels', [channelId]);
    if (!users || users.length === 0) return;

    if (msg.photo) {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        const fileLink = await ctx.telegram.getFileLink(fileId);
        
        try {
            // Upload to ImgBB
            const imgbb = await axios.post(`https://api.imgbb.com/1/upload?key=${IMGBB_API}&image=${encodeURIComponent(fileLink)}`);
            const imageUrl = imgbb.data.data.url;

            // Save to Supabase
            const { data: post } = await supabase.from('posts').insert([{
                author_id: channelId, author_name: msg.chat.title, type: 'channel',
                text: msg.caption || '', image_url: imageUrl
            }]).select();

            // Send Notification to Followers
            const { data: follows } = await supabase.from('follows').select('follower_id').eq('following_id', channelId);
            follows?.forEach(async (f) => {
                const { data: u } = await supabase.from('users').select('push_notif').eq('tg_id', f.follower_id).single();
                if (u?.push_notif) {
                    bot.telegram.sendMessage(f.follower_id, `🔔 **${msg.chat.title}** posted a new update!`, {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [[ { text: 'View Post 👀', web_app: { url: `${process.env.MINI_APP_URL}?startapp=post_${post[0].id}` } } ]]
                        }
                    }).catch(e => console.log("Bot blocked"));
                }
            });
        } catch (e) { console.error("Sync Error", e); }
    }
});

// ==========================================
// 4. API: Auth, Validation & Auto-Welcome 
// ==========================================
app.post('/api/auth', async (req, res) => {
    const { initData } = req.body;
    
    // Validate HMAC SHA-256
    const urlParams = new URLSearchParams(initData);
    const hash = urlParams.get('hash');
    urlParams.delete('hash');
    urlParams.sort();
    let dataCheckString = '';
    for (const [key, value] of urlParams.entries()) dataCheckString += `${key}=${value}\n`;
    
    const secret = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN).digest();
    const calcHash = crypto.createHmac('sha256', secret).update(dataCheckString.slice(0, -1)).digest('hex');
    
    if (calcHash !== hash) return res.status(403).json({ error: "Unauthorized" });

    const tgUser = JSON.parse(urlParams.get('user'));
    const tgId = tgUser.id.toString();

    const { data: user } = await supabase.from('users').select('*').eq('tg_id', tgId).single();

    // 💡 Auto Welcome Logic: If user opened Direct Link without /start
    if (!user) {
        await supabase.from('users').insert([{ 
            tg_id: tgId, name: tgUser.first_name, username: tgUser.username || '' 
        }]);
        
        // Auto send DM via Bot
        bot.telegram.sendMessage(tgId, `👋 Hello ${tgUser.first_name}, Welcome to our App!`, {
            reply_markup: { inline_keyboard: [[ { text: 'Open App', web_app: { url: process.env.MINI_APP_URL } } ]] }
        }).catch(e => console.log("Can't send welcome message"));
    }
    
    res.json({ success: true, user: user || tgUser });
});

// ==========================================
// 5. API: Create Post (Daily Limit Check)
// ==========================================
app.post('/api/createPost', async (req, res) => {
    const { tgId, text, imageBase64 } = req.body;

    const { data: user } = await supabase.from('users').select('*').eq('tg_id', tgId).single();
    const limits = getLevelData(user.refer_count);

    // Limit Logic Check (Simplistic: count posts today)
    const today = new Date().toISOString().split('T')[0];
    const { count } = await supabase.from('posts').select('*', { count: 'exact' })
        .eq('author_id', tgId).gte('created_at', today);

    if (count >= limits.limit) return res.status(400).json({ error: `Daily limit of ${limits.limit} posts reached.` });

    let imageUrl = '';
    if (imageBase64) {
        const form = new URLSearchParams();
        form.append('image', imageBase64.split(',')[1]); 
        const imgbb = await axios.post(`https://api.imgbb.com/1/upload?key=${IMGBB_API}`, form);
        imageUrl = imgbb.data.data.url;
    }

    await supabase.from('posts').insert([{ author_id: tgId, author_name: user.name, type: 'user', text, image_url: imageUrl }]);
    res.json({ success: true });
});

app.use(bot.webhookCallback('/webhook'));
app.listen(process.env.PORT || 3000, async () => {
    console.log("Server Live!");
    await bot.telegram.setWebhook(`${process.env.RENDER_EXTERNAL_URL}/webhook`);
});
