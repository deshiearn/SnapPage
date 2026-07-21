require('dotenv').config();
const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const admin = require('firebase-admin');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');

// Firebase Admin Setup
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const app = express();
app.use(cors());
app.use(express.json());

const bot = new Telegraf(process.env.BOT_TOKEN);
const IMGBB_API_KEY = process.env.IMGBB_API_KEY;

// ==========================================
// 1. Level & Post Limit Logic
// ==========================================
const getLevelDetails = (referCount) => {
    if (referCount >= 10) return { level: 5, limit: 9999, channels: 5, badge: true };
    if (referCount >= 8) return { level: 4, limit: 9, channels: 1, badge: false };
    if (referCount >= 6) return { level: 3, limit: 7, channels: 1, badge: false };
    if (referCount >= 4) return { level: 2, limit: 4, channels: 1, badge: false };
    return { level: 1, limit: 2, channels: 1, badge: false };
};

// ==========================================
// 2. Bot Commands & Referral System
// ==========================================
bot.start(async (ctx) => {
    const tgId = ctx.from.id.toString();
    const referId = ctx.message.text.split(' ')[1]; // Extract referral ID

    const userRef = db.collection('users').doc(tgId);
    const doc = await userRef.get();

    if (!doc.exists) {
        // New User
        await userRef.set({
            tgId,
            name: ctx.from.first_name,
            photoUrl: '', // Fetch profile pic via API if needed
            referCount: 0,
            level: 1,
            addedChannels: [],
            pushNotif: true
        });

        // Increase referral count for the referrer
        if (referId && referId !== tgId) {
            const referrerRef = db.collection('users').doc(referId);
            await db.runTransaction(async (t) => {
                const referrerDoc = await t.get(referrerRef);
                if (referrerDoc.exists) {
                    const newCount = referrerDoc.data().referCount + 1;
                    t.update(referrerRef, { referCount: newCount, ...getLevelDetails(newCount) });
                }
            });
            ctx.telegram.sendMessage(referId, `🎉 নতুন একজন আপনার লিংকে জয়েন করেছে!`);
        }
    }

    ctx.reply('Welcome! Open the Mini App 👇', Markup.inlineKeyboard([
        Markup.button.webApp('Launch App 🚀', process.env.MINI_APP_URL)
    ]));
});

// ==========================================
// 3. Channel Auto-Post & ImgBB Sync
// ==========================================
bot.on('channel_post', async (ctx) => {
    const channelId = ctx.update.channel_post.chat.id.toString();
    const message = ctx.update.channel_post;

    // Check if channel is registered by any user
    const usersSnapshot = await db.collection('users').where('addedChannels', 'array-contains', channelId).get();
    if (usersSnapshot.empty) return;

    if (message.photo) {
        const fileId = message.photo[message.photo.length - 1].file_id;
        const fileLink = await ctx.telegram.getFileLink(fileId);
        const caption = message.caption || "";

        // Upload to ImgBB
        try {
            const imgbbRes = await axios.post(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}&image=${encodeURIComponent(fileLink)}`);
            const imageUrl = imgbbRes.data.data.url;

            const newPost = {
                authorId: channelId,
                authorName: ctx.update.channel_post.chat.title,
                type: 'channel',
                imageUrl,
                text: caption,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            };

            const postRef = await db.collection('posts').add(newPost);

            // ==========================================
            // 4. Notification System (Followers)
            // ==========================================
            const followsSnapshot = await db.collection('follows').where('followingId', '==', channelId).get();
            followsSnapshot.forEach(async (doc) => {
                const followerId = doc.data().followerId;
                
                // Check if user has notification ON
                const userDoc = await db.collection('users').doc(followerId).get();
                if(userDoc.exists && userDoc.data().pushNotif) {
                     // Send Inline Button with Deep Link
                     ctx.telegram.sendMessage(followerId, `🔔 **${ctx.update.channel_post.chat.title}** নতুন একটি পোস্ট করেছে!`, {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [[
                                { text: 'View Post 👀', web_app: { url: `${process.env.MINI_APP_URL}?startapp=post_${postRef.id}` } }
                            ]]
                        }
                    });
                }
            });

        } catch (error) {
            console.error("ImgBB Upload Failed:", error);
        }
    }
});

// ==========================================
// 5. API for Frontend (initData Auth & Create Post)
// ==========================================
app.post('/api/createPost', async (req, res) => {
    const { initData, text, imageUrl } = req.body;
    
    // WebApp Data Validation Logic (Security)
    const urlParams = new URLSearchParams(initData);
    const hash = urlParams.get('hash');
    urlParams.delete('hash');
    urlParams.sort();
    let dataCheckString = '';
    for (const [key, value] of urlParams.entries()) {
        dataCheckString += `${key}=${value}\n`;
    }
    dataCheckString = dataCheckString.slice(0, -1);
    
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN).digest();
    const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (calculatedHash !== hash) return res.status(403).json({ error: 'Unauthorized/Fake User' });

    const user = JSON.parse(urlParams.get('user'));
    
    // Check Daily Limit
    const userDoc = await db.collection('users').doc(user.id.toString()).get();
    const today = new Date().toISOString().split('T')[0];
    const postCountToday = (userDoc.data().postsLog || {})[today] || 0;
    
    if (postCountToday >= getLevelDetails(userDoc.data().referCount).limit) {
         return res.status(400).json({ error: 'Daily Post Limit Reached!' });
    }

    // Save Post
    await db.collection('posts').add({
        authorId: user.id.toString(),
        authorName: user.first_name,
        type: 'user',
        text,
        imageUrl,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ success: true });
});

app.use(bot.webhookCallback('/webhook'));
app.listen(process.env.PORT || 3000, async () => {
    console.log('Server is running!');
    await bot.telegram.setWebhook(`${process.env.RENDER_EXTERNAL_URL}/webhook`);
});
