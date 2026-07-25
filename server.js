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
app.use(express.json());

// Supabase & Bot Setup
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const bot = new Telegraf(process.env.BOT_TOKEN);
const IMGBB_API_KEY = process.env.IMGBB_API_KEY;

// Level Logic
const getLevelDetails = (referCount) => {
    if (referCount >= 10) return { level: 5, limit: 9999, channels: 5 };
    if (referCount >= 8) return { level: 4, limit: 9, channels: 1 };
    if (referCount >= 6) return { level: 3, limit: 7, channels: 1 };
    if (referCount >= 4) return { level: 2, limit: 4, channels: 1 };
    return { level: 1, limit: 2, channels: 1 };
};

// Bot /start Command
bot.start(async (ctx) => {
    const tgId = ctx.from.id.toString();
    const referId = ctx.message.text.split(' ')[1];

    const { data: user } = await supabase.from('users').select('*').eq('tg_id', tgId).single();

    if (!user) {
        await supabase.from('users').insert([{ tg_id: tgId, name: ctx.from.first_name }]);

        // Referral Logic
        if (referId && referId !== tgId) {
            const { data: referrer } = await supabase.from('users').select('refer_count').eq('tg_id', referId).single();
            if (referrer) {
                const newCount = referrer.refer_count + 1;
                const { level } = getLevelDetails(newCount);
                await supabase.from('users').update({ refer_count: newCount, level }).eq('tg_id', referId);
                ctx.telegram.sendMessage(referId, `🎉 নতুন একজন আপনার লিংকে জয়েন করেছে!`);
            }
        }
    }

    ctx.reply('Welcome! Open the Mini App 👇', Markup.inlineKeyboard([
        Markup.button.webApp('Launch App 🚀', process.env.MINI_APP_URL)
    ]));
});

// Channel Auto Post Logic
bot.on('channel_post', async (ctx) => {
    const channelId = ctx.update.channel_post.chat.id.toString();
    const message = ctx.update.channel_post;

    // Check if channel is added by any user
    const { data: users } = await supabase.from('users').select('tg_id').contains('added_channels', [channelId]);
    if (!users || users.length === 0) return;

    if (message.photo) {
        const fileId = message.photo[message.photo.length - 1].file_id;
        const fileLink = await ctx.telegram.getFileLink(fileId);
        
        try {
            const imgbbRes = await axios.post(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}&image=${encodeURIComponent(fileLink)}`);
            const imageUrl = imgbbRes.data.data.url;

            const { data: postData } = await supabase.from('posts').insert([{
                author_id: channelId,
                author_name: ctx.update.channel_post.chat.title,
                type: 'channel',
                text: message.caption || "",
                image_url: imageUrl
            }]).select();

            // Notify Followers
            const { data: follows } = await supabase.from('follows').select('follower_id').eq('following_id', channelId);
            if (follows) {
                follows.forEach(async (f) => {
                    const { data: u } = await supabase.from('users').select('push_notif').eq('tg_id', f.follower_id).single();
                    if(u && u.push_notif) {
                        ctx.telegram.sendMessage(f.follower_id, `🔔 **${ctx.update.channel_post.chat.title}** নতুন একটি পোস্ট করেছে!`, {
                            parse_mode: 'Markdown',
                            reply_markup: {
                                inline_keyboard: [[ { text: 'View Post 👀', web_app: { url: `${process.env.MINI_APP_URL}?startapp=post_${postData[0].id}` } } ]]
                            }
                        });
                    }
                });
            }
        } catch (error) {
            console.error("Error:", error);
        }
    }
});

// Create Post API from Frontend
app.post('/api/createPost', async (req, res) => {
    const { initData, text, imageUrl } = req.body;
    
    // Telegram Security Verification
    const urlParams = new URLSearchParams(initData);
    const hash = urlParams.get('hash');
    urlParams.delete('hash');
    urlParams.sort();
    let dataCheckString = '';
    for (const [key, value] of urlParams.entries()) dataCheckString += `${key}=${value}\n`;
    dataCheckString = dataCheckString.slice(0, -1);
    
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN).digest();
    const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (calculatedHash !== hash) return res.status(403).json({ error: 'Unauthorized' });

    const user = JSON.parse(urlParams.get('user'));
    
    // Insert Post
    await supabase.from('posts').insert([{
        author_id: user.id.toString(),
        author_name: user.first_name,
        type: 'user',
        text,
        image_url: imageUrl
    }]);

    res.json({ success: true });
});

// Serve Frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.use(bot.webhookCallback('/webhook'));
app.listen(process.env.PORT || 3000, async () => {
    console.log('Server is running!');
    await bot.telegram.setWebhook(`${process.env.RENDER_EXTERNAL_URL}/webhook`);
});
