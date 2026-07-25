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
// Image base64 রিসিভ করার জন্য লিমিট বাড়ানো হলো
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ limit: '15mb', extended: true }));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const bot = new Telegraf(process.env.BOT_TOKEN);
const IMGBB_API_KEY = process.env.IMGBB_API_KEY;

// --- Notification Function ---
async function sendNotification(targetUserId, message, postId) {
    const { data: user } = await supabase.from('users').select('push_notif').eq('tg_id', targetUserId).single();
    if (user && user.push_notif) {
        bot.telegram.sendMessage(targetUserId, message, {
            reply_markup: {
                inline_keyboard: [[ { text: 'Check Post 👀', web_app: { url: `${process.env.MINI_APP_URL}?startapp=post_${postId}` } } ]]
            }
        }).catch(e => console.log("Bot blocked by user"));
    }
}

// --- Create Post & ImgBB Upload ---
app.post('/api/createPost', async (req, res) => {
    const { initData, text, imageBase64 } = req.body;
    const user = JSON.parse(new URLSearchParams(initData).get('user'));
    
    let imageUrl = '';
    if (imageBase64) {
        try {
            // ImgBB তে Base64 আপলোড
            const form = new URLSearchParams();
            form.append('image', imageBase64.split(',')[1]); 
            const imgbbRes = await axios.post(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`, form);
            imageUrl = imgbbRes.data.data.url;
        } catch (e) { return res.status(500).json({ error: 'Image upload failed' }); }
    }

    const { data, error } = await supabase.from('posts').insert([{
        author_id: user.id.toString(),
        author_name: user.first_name,
        type: 'user',
        text: text,
        image_url: imageUrl
    }]).select();

    if(error) return res.status(500).json({ error: error.message });
    res.json({ success: true, post: data[0] });
});

// --- Interact API (Like, Share, Report) ---
app.post('/api/interact', async (req, res) => {
    const { initData, postId, action, targetUserId } = req.body;
    const user = JSON.parse(new URLSearchParams(initData).get('user'));
    const userId = user.id.toString();

    if (action === 'like') {
        const { data: post } = await supabase.from('posts').select('likes').eq('id', postId).single();
        let likes = post.likes || [];
        if (!likes.includes(userId)) {
            likes.push(userId);
            await supabase.from('posts').update({ likes }).eq('id', postId);
            if(userId !== targetUserId) sendNotification(targetUserId, `❤️ **${user.first_name}** liked your post!`, postId);
        } else {
            likes = likes.filter(id => id !== userId);
            await supabase.from('posts').update({ likes }).eq('id', postId);
        }
        res.json({ success: true, likes: likes.length });
    }
    
    else if (action === 'share') {
        const { data: post } = await supabase.from('posts').select('shares').eq('id', postId).single();
        await supabase.from('posts').update({ shares: post.shares + 1 }).eq('id', postId);
        if(userId !== targetUserId) sendNotification(targetUserId, `🔄 **${user.first_name}** shared your post!`, postId);
        res.json({ success: true });
    }

    else if (action === 'report') {
        await supabase.from('reports').insert([{ post_id: postId, reporter_id: userId }]);
        res.json({ success: true });
    }
});

// --- Settings Updates API ---
app.post('/api/updateSettings', async (req, res) => {
    const { initData, push_notif, lang, photo_url, username } = req.body;
    const user = JSON.parse(new URLSearchParams(initData).get('user'));
    
    await supabase.from('users').upsert({
        tg_id: user.id.toString(),
        name: user.first_name,
        username: username || '',
        photo_url: photo_url || '',
        lang: lang,
        push_notif: push_notif
    });
    res.json({ success: true });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.listen(process.env.PORT || 3000, () => console.log('Server running!'));
