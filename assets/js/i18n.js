'use strict';
// Tiny i18n: English + বাংলা for the main screens. Add keys here; mark HTML with data-i18n / data-i18n-ph.
(function () {
    const D = {
        en: {
            for_you: 'For You', following: 'Following', search_ph: 'Search posts, videos & people...', your_story: 'Your story',
            like: 'Like', comment: 'Comment', share: 'Share', see_more: 'See more', see_less: 'See less',
            appearance: 'Appearance', theme: 'Theme', system: 'System', light: 'Light', dark: 'Dark', language: 'Language',
            notifications: 'Notifications', notif_desc: 'Telegram bot messages for likes, comments & more', preferences: 'Preferences',
            channels: 'My Channels', invite: 'Invite & Level Up', support: 'Support', privacy: 'Privacy Policy', terms: 'Terms of Use', legal: 'About & Legal',
            edit: 'Edit', edit_profile: 'Edit Profile', name: 'Name', username: 'Username', save: 'Save', change_photo: 'Change photo',
            comments_title: 'Comments', write_comment: 'Write a comment...', no_comments: 'No comments yet',
            posts: 'Posts', reels: 'Reels', followers: 'Followers', following_n: 'Following', copy_link: 'Copy Link',
            chat_tg: 'Chat with Telegram', visit_tg: 'Visit in Telegram', founder: 'Founder', follow: 'Follow',
            create_post: 'Create Post', post: 'Post', whats_on_mind: "What's on your mind?", add_photos: 'Add Photos (Max 4)', live_preview: 'LIVE PREVIEW',
            notifications_title: 'Notifications', clear_all: 'Clear all', no_notifs: 'No notifications yet',
            version: 'SnapPages', related_reels: 'Related reels'
        },
        bn: {
            for_you: 'আপনার জন্য', following: 'ফলো করছেন', search_ph: 'পোস্ট, ভিডিও ও মানুষ খুঁজুন...', your_story: 'আপনার স্টোরি',
            like: 'লাইক', comment: 'কমেন্ট', share: 'শেয়ার', see_more: 'আরও দেখুন', see_less: 'কম দেখুন',
            appearance: 'চেহারা', theme: 'থিম', system: 'সিস্টেম', light: 'লাইট', dark: 'ডার্ক', language: 'ভাষা',
            notifications: 'নোটিফিকেশন', notif_desc: 'লাইক, কমেন্ট ইত্যাদির জন্য Telegram বট মেসেজ', preferences: 'পছন্দসমূহ',
            channels: 'আমার চ্যানেল', invite: 'ইনভাইট ও লেভেল আপ', support: 'সাপোর্ট', privacy: 'প্রাইভেসি পলিসি', terms: 'ব্যবহারের শর্তাবলি', legal: 'সম্পর্কে ও আইনি',
            edit: 'এডিট', edit_profile: 'প্রোফাইল এডিট', name: 'নাম', username: 'ইউজারনেম', save: 'সেভ', change_photo: 'ছবি পরিবর্তন',
            comments_title: 'কমেন্টস', write_comment: 'কমেন্ট লিখুন...', no_comments: 'এখনো কোনো কমেন্ট নেই',
            posts: 'পোস্ট', reels: 'রিলস', followers: 'ফলোয়ার', following_n: 'ফলোয়িং', copy_link: 'লিংক কপি',
            chat_tg: 'Telegram-এ চ্যাট করুন', visit_tg: 'Telegram-এ দেখুন', founder: 'প্রতিষ্ঠাতা', follow: 'ফলো',
            create_post: 'পোস্ট তৈরি', post: 'পোস্ট', whats_on_mind: 'আপনার মনে কী চলছে?', add_photos: 'ছবি যোগ করুন (সর্বোচ্চ ৪)', live_preview: 'লাইভ প্রিভিউ',
            notifications_title: 'নোটিফিকেশন', clear_all: 'সব মুছুন', no_notifs: 'এখনো কোনো নোটিফিকেশন নেই',
            version: 'স্ন্যাপপেজেস', related_reels: 'সম্পর্কিত রিলস'
        }
    };
    let lang = 'en';
    try { lang = localStorage.getItem('snap_lang') || ''; } catch (e) {}
    if (!lang) {
        const tl = (window.Telegram.WebApp.initDataUnsafe && window.Telegram.WebApp.initDataUnsafe.user && window.Telegram.WebApp.initDataUnsafe.user.language_code) || navigator.language || 'en';
        lang = /^bn/i.test(tl) ? 'bn' : 'en';
    }
    window.getLang = () => lang;
    window.t = (k) => (D[lang] && D[lang][k]) || D.en[k] || k;
    window.applyLang = () => {
        document.documentElement.lang = lang;
        document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
        document.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
        document.querySelectorAll('[data-lang-btn]').forEach(b => b.classList.toggle('active', b.dataset.langBtn === lang));
    };
    window.setLang = (l) => {
        lang = l; try { localStorage.setItem('snap_lang', l); } catch (e) {}
        applyLang();
        if (typeof loadPosts === 'function') loadPosts(1, true);     // re-render cards in the new language
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', applyLang); else applyLang();
})();
