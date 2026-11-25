# SnapPages

A social-feed **Telegram Mini App** (Facebook/Instagram style) that runs inside Telegram.
Users post, comment, like, follow each other, watch short videos, and any Telegram **channel** they
connect is auto-posted into the feed with its name and photo.

Built to run entirely on **free tiers**: Render (hosting) + Supabase (database) + GitHub + Telegram (file storage).

## Features
- **Feed** with *For You* and *Following* tabs, infinite scroll, pinned posts, search
- **Profiles** (users and channels) with follower counts, a Follow button and their posts
- **Stories** – 24-hour image status on top of the feed (tap to view, hold to pause, up to 5 at a time)
- **Shorts** – TikTok-style vertical video feed (videos are stored in Telegram, not in the database)
- **Channel auto-post** – add a channel, and every new post/video in it appears in the feed; the channel owner gets a Telegram notification with *Remove Post* / *Open App* buttons
- **Comments** with replies, @mentions (notified via the bot), likes, albums/multi-image posts, caption formatting (bold, links, `@bot` mentions)
- **Reactions** – long-press the Like button: ❤️ 😂 😮 😢 🔥 👍; the reaction totals show under each post like Telegram, tap a chip to toggle yours
- **View counts** on posts, and a **weekly channel report** sent to channel owners by the bot every Sunday (~10:00 Bangladesh time)
- **Hashtags** (tap to search, Bengali supported) and **trending tags**; **daily streak** 🔥
- **Referral levels** – 2 referrals → Level 2 (image posts, links, 3 channels), 3 referrals → Level 3 (rich text links, 5 channels)
- **Telegram notifications** for likes, comments and new followers (rate-limited)
- **Admin Panel** at `/admin` – dashboard, reports, broadcast, blue badge, pin post, maintenance mode, ban/delete users
- Dark mode (dark grey), animations, Bengali-friendly

## Project structure
```
server.js              Express + Telegraf bot + all API routes
index.html             User panel markup only
indexadmin.html        Admin panel (served at /admin)
assets/css/            app.css (own styles), icons.css (slim icon font), tailwind.css (prebuilt)
assets/js/             core, ui, format, feed, shorts, actions, extras, profile, boot  (loaded in this order)
assets/fonts/          subsetted Font Awesome (only the icons used)
src/tailwind.css       Tailwind source        tailwind.config.js   Tailwind config
sql/                   Supabase migrations (run in order, see below)
```

## Setup

### 1. Telegram bot
1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. `/newapp` (or *Bot Settings → Configure Mini App*) → set the URL to your Render URL. Optionally enable *Launch in fullscreen*.
3. Create a **private channel** used as video/image storage, add the bot as admin, and note its id (`-100…`).

### 2. Supabase
Create a project, then in **SQL Editor** paste and run the files in `sql/` in this order
(paste the *contents* of each file, not its name):

| Order | File | Purpose |
|---|---|---|
| 1 | `01_admin_panel_migration.sql` | admin, reports, bans, settings |
| 2 | `02_shorts_migration.sql` | videos table |
| 3 | `03_fix_missing_referred_by_column.sql` | referral column |
| 4 | `04_fix_comments_post_id_type.sql`, `04b_comment_likes_and_entities_migration.sql` | comments for posts + videos, likes, caption formatting |
| 5 | `05_fix_reports_table.sql` | makes reports work for posts and videos |
| 6 | `06_social_migration.sql` | follow system + performance indexes |
| 7 | `07_streak_migration.sql` | daily streak |
| 8 | `08_reactions_and_replies.sql` | comment replies + emoji reactions |
| 9 | `09_views_and_stats.sql` | view counts |
| 10 | `10_stories.sql` | stories (24-hour status) |
| 11 | `11_notifications_and_username.sql` | in-app notifications + editable @username |
| 12 | `12_settings_ads_premium.sql` | notification On/Off switch, ads table |
| 14 | `14_story_video.sql` | Video stories |
| 13 | `13_channel_sync_rich.sql` | channel sync (deletions/edits) + rich posts |

Then make yourself admin: `update users set is_admin = true where tg_id = 'YOUR_TELEGRAM_ID';`

### 3. Render
New **Web Service** from this repo — Build: `npm install`, Start: `npm start`. Environment variables:

| Variable | Value |
|---|---|
| `BOT_TOKEN` | token from BotFather |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Supabase **service role** key (server only – never put it in front-end code) |
| `MINI_APP_URL` | your Render URL, e.g. `https://snappage.onrender.com` |
| `STORAGE_CHANNEL_ID` | the private storage channel id |
| `ADMIN_PASSWORD` | password for the Admin Panel |

`RENDER_EXTERNAL_URL` is provided by Render automatically (used for the webhook and the keep-alive ping).

## Telegram look & feel

- **Theme colours** – `assets/js/theme.js` reads `Telegram.WebApp.themeParams` and exposes them as CSS variables (`--app-bg`, `--app-surface`, `--app-text`, `--app-hint`, `--app-link`, `--app-accent`, ...). It re-applies on `themeChanged`, so switching Telegram's theme updates the app live. If a client sends no params, built-in light/dark defaults are used. Header, background and bottom-bar colours are also set (`setHeaderColor`, `setBackgroundColor`, `setBottomBarColor`, version-guarded).
- **MainButton** – the native bottom button is used for *Post / Save* (composer), *Share Story* and *Invite Friends* (referral sheet; opens Telegram's share sheet). It shows a progress spinner while uploading and is disabled for an empty post. Outside Telegram (or on very old clients) the in-page buttons stay visible instead. Register a new screen with `MB_SCREENS['<modalId>'] = () => MB.show(...)`.
- **Safe areas** – `--top-inset` follows `safeAreaInset` + `contentSafeAreaInset` in fullscreen (Bot API 8.0+), falling back to CSS `env()`.

## Profiles, share links & invites

- Profile sheet has **Posts / Reels** tabs. Reels show as a small thumbnail grid; tapping one opens the main Reels page starting at that reel (rest of the feed follows).
- **Copy Link / Share** on a profile gives `https://t.me/<bot>/app?startapp=profile_<id>_ref_<yourId>`. Opening it lands straight on that profile, and a brand-new user who joins through it is counted as *your* invite (referral levels). Post and Reel share links carry the same `_ref_` suffix.
- Follow needs `sql/06_social_migration.sql` (creates `snap_follows`). If it is missing the app now says so instead of a vague error.

## Instant posting + live preview

- While writing, a **Live Preview** shows the post exactly as it will look in the feed (text, hashtags, photos).
- Pressing Post closes the composer immediately and shows the post at the top of the feed ("Posting…") while it uploads in the background. If the upload fails, the card is removed and the draft is restored so nothing is lost.
- Photos are downscaled in the browser (max 1280px JPEG) before upload, which makes posting faster and saves Supabase/Telegram bandwidth.

## Browser mode, notifications & profile editing

- **Open in a normal browser** (outside Telegram): the app creates a throw-away *guest account* (signed token from `/api/guestInit`, stored in `localStorage`, max 15 new guests/hour per IP) and shows a top banner: *"Use Telegram to access all features"* with an **Open Telegram** button. Guests can browse, post, like and comment; Telegram DMs/referrals need the real Telegram app.
- **In-app notifications** (🔔 in the header): likes, reactions, comments, replies, @mentions, comment likes, shares, view milestones (10/25/50/100…), new followers and new referrals. Tap one to jump to that post / comment / reel / profile; ✕ removes it, *Clear all* wipes the list. Rows older than 30 days are pruned automatically. Needs `sql/11`.
- **Edit profile** (Settings → *Edit*): change display name and `@username` (4–20 letters/numbers/_, unique). Old posts show the new name automatically.
- **Photo + text posts are open to every user** (the old Level-2 gate is gone).
- **Performance**: off-screen cards skip rendering (`content-visibility`), weak phones / data-saver get a *lite* mode (no blur, fewer animations), `prefers-reduced-motion` is respected.
- After adding a new `fa-*` icon run `python3 tools/build-icons.py` (needs a Font Awesome Free 6 folder, see the script header).

## Channel sync, rich posts & Me page

- **Storage channel** is set in *Admin panel → Storage Channel* (the bot is tested: must be admin and able to post).
- **Channel sync**: when a channel changes its photo/name the app updates at once; edited channel posts are edited in the app; posts/videos deleted in the channel are removed from the app (Bot API sends no delete event, so recent posts are probed every 10 min while the app is used and hourly — needs the storage channel and `sql/13`).
- **New Telegram formats** (`rich_message`, Bot API 10.1+): tables, slideshows, collages, lists, headings, quotes are rendered natively (`assets/js/rich.js`).
- **Me page / profiles** follow Telegram iOS: gradient header with big avatar, rounded menu groups; Theme / Language / Notifications live under *Settings*. The Founder profile (`FOUNDER_ID`, default 7767338426) gets the animated premium look.

## Working within the free tiers
The app is designed so that normal growth does not hit a limit:

| Limit (free plan) | How the app stays under it |
|---|---|
| Supabase **500 MB** database | Only text and Telegram `file_id`s are stored – never files. Feed is capped (2,500 posts, 300 videos); older ones are removed automatically. |
| Supabase **egress / requests** | Feed responses are paginated (max 20 per call). Author data (photos, levels, channel owners) is looked up in **batches and cached in memory** (30–300 s) instead of per-post queries. Indexes (`sql/06`) keep queries fast. |
| Supabase pauses after **1 week idle** | Normal usage keeps it active. If it ever pauses, press *Restore* in the dashboard. |
| Render **sleeps after 15 min idle** | The server pings its own `/healthz` every 10 minutes, so it stays awake (one always-on free service ≈ 744 of the 750 free hours/month). |
| Render **512 MB RAM** | Caches are size-limited; videos/images are streamed from Telegram, not stored on the server. |
| Telegram bot **rate limits** | Max 15 notifications per user per hour; channel albums are merged into one post. |
| Slow phones / slow networks | Static files are cached for a year (versioned per deploy) and gzip-compressed; Tailwind is prebuilt (21 KB) and the icon font is a 7 KB subset. |
| Video size | 18 MB per video (Telegram bot download limit is 20 MB). |

If the app outgrows the free plans, the upgrade path is: Render *Starter* (no sleeping), Supabase *Pro*. No code changes are needed.

## Development notes
- Tailwind is prebuilt. After adding **new** Tailwind classes in `index.html` or `assets/js`, rebuild with the
  [standalone CLI](https://github.com/tailwindlabs/tailwindcss/releases) (v3):
  `tailwindcss -c tailwind.config.js -i src/tailwind.css -o assets/css/tailwind.css --minify`
- Icons: only icons already in `assets/css/icons.css` are available. New icons must be added to that file (and the font subset regenerated).
- Static file URLs carry `?v=<deploy id>`, so a new deploy never serves stale CSS/JS.

## Security
- All API routes validate Telegram `initData` (HMAC) – the user id always comes from Telegram, never from the request body.
- The Supabase **service key** is used only on the server. Admin routes need the user to be an admin **and** the admin password.
- Banned users/channels are blocked from re-registering.


## Search, video stories, Ads and Level Perks
- **Search** finds people and channels (by name or @username → opens profile), a strip of related Reels thumbnails (tap → Reels page), and posts.
- **Video stories**: up to 30 s / 12 MB. Run `sql/14_story_video.sql`.
- **Ads**: Admin panel → Ads (title, text, image, link, button). Shown as "Sponsored" cards in the feed; impressions/clicks counted (run `sql/12_settings_ads_premium.sql`, it adds `bump_ad`).
- **Level Perks**: all basic features free. Level 2 → reactions 🎉🥰, 5 stories; Level 3 → 💎🤯, 8 photos/post, 8 stories. See Me → Level Perks.

## Reels redesign, Referral page, static emojis
- **Reels**: full-screen, Following / For You tabs, back + sound + upload in the top bar, action rail on the right (avatar with +Follow, like/reactions, comment, share, more), author + caption bottom-left, scrubbable progress bar, double-tap to like (heart burst), auto-plays the next reel when one ends, next video is pre-loaded. Portrait videos fill the screen, landscape ones fit.
- **Referral page** now uses the same grouped-card style as the Me page (level hero, copy/share, network stats, perks, history).
- Emojis inside posts are plain static text (no animation) for a calmer, lighter feed.

## Back button, dark-mode fixes, founder profile
- Phone/Telegram **Back** now steps back instead of closing the app: it clears an active search, and from the Me tab returns to Home. The app only closes from the plain Home feed.
- Dark mode: search result cards and sponsored (ad) cards now follow the theme (text was unreadable).
- Founder profile: aurora background, twinkling sparkles, floating crown, rotating golden ring with a pulse, staggered entrance. All profiles get a staggered entrance for stats/buttons. Animations are transform/opacity only, off in Lite mode and with "reduce motion".

## Capacity, ranking, admin System tab, composers (Nov 2026)
- **sql/15_profile_sync_system.sql** (run it): Telegram name/@username/photo auto-sync on app open (every 6 h, hand-edited name/photo never overwritten), `db_stats()` for exact DB size in Admin → System, and feed indexes.
- **Feed + Reels ranking** ("For You"): engagement ÷ age^1.15, ×1.7 followed authors, ×0.15 already-seen, author diversity, fresh-post boost; stateless pagination (`exclude` + `cursor`). Seen items are remembered on the device (`snap_seen`).
- **Reels**: only reels within ~2 screens keep a loaded video (smooth on low-end phones); next two are pre-buffered; a slow reel (>2.5 s) is skipped for the next one that is ready; broken videos are dropped, offline never drops anything.
- **Admin panel** now uses the same built CSS/icons as the app (no runtime Tailwind CDN; Chart.js loads only on the dashboard), light + dark. New **System** tab: RAM, DB size, req/min, content counts, capacity guide, post/video retention limits, "Test upload to storage channel", "Clean up & free memory". Defaults: 20 000 posts / 1 500 reels kept.
- Uploads: friendly error reasons (bot not admin, channel not found, rate limit…), one automatic retry, max 3 simultaneous uploads, 28 MB request cap (protects the 512 MB instance).
- Fonts are cache-busted by content hash, so newly added icons can never be missing because of a stale cached font.
- **Create Post** and **New Reel** sheets redesigned (author row, auto-growing text, photo grid, emoji strip, hashtag/mention, counters, draft autosave; reel preview, real upload progress bar).

## Telegram-iOS style composers
Create Post and New Reel now follow the Telegram iOS look: nav bar (Cancel · title · bold action), grouped inset cards, coloured icon rows (Photos / Hashtag / Mention / Emoji), section headers and footers with counters, light + dark.

## Comments, notifications, upload hardening, token safety
- **Comments** rebuilt Telegram-style: avatars (live photo/name), time, heart on the right, collapsible replies, **instant posting** (shows immediately, rolls back with your text restored on failure), Enter to send, **smart emoji suggestions** (English + Bengali keywords) and **one-tap quick replies**, sheet lifts above the keyboard.
- **Notifications** sheet uses the same Telegram-style list and nav bar.
- **Security**: photos/videos are now streamed through the server (`/api/tgImage`, `/api/tgVideo`, `/api/videoStream`) instead of redirecting to Telegram's file URL, which exposed the bot token to every viewer. Images are cached for a year (immutable file ids). Note: media bandwidth now passes through Render (100 GB/month free).
- **Photo upload**: gallery pickers use `image/*` / `video/*` (opens the gallery, not the file manager); unsupported formats give a clear message; if uploads fail the admins get a bot message with the exact reason (once an hour); duplicate cap query removed from post creation.


## Stars & paid content (Stage E)

- **Paid posts / paid reels**: in the composer switch on *Paid post* (or *Paid reel*) and set a price in Stars. Viewers see a blurred preview and unlock with Stars; the creator receives the price minus a platform fee (default 10 %, editable in Admin → Stars).
- **Premium tab** next to *Following* on Home and next to *For You* in Reels: only paid items. Paid items also appear (locked) in normal feeds.
- **Star reactions (tips)**: the ⭐ button on posts/reels sends Stars to the creator.
- **My Stars** (Me page): balance, history, *Add Stars* (xRocket) and *Withdraw* (coming soon).
- **Security**: real media of paid items lives in `paid_assets` (never returned by feeds); paid videos stream only with a signed, per-user token; unlock/tip/deposit are atomic SQL functions (no double-spend, no double-credit).
- **Deposits (xRocket)**: Admin → Stars → paste the xRocket Pay API key, currency and "Stars per 1 unit". The server creates an invoice, then re-reads it from xRocket (it never trusts webhook bodies) and credits Stars automatically (polling from the app + webhook hint + 1-minute safety net). API style can be `auto`, `v1` (Bearer) or `legacy` (Rocket-Pay-Key).
- **SQL**: run `sql/16_stars_paid.sql` in Supabase.

### Payout, Star reactions and maintenance (Stage F)

- **Top Up / Withdraw** screens follow the Telegram iOS "Stars" design. Withdraw holds the Stars immediately and creates a request; Admin → Stars → *Payout requests* shows them with **Mark paid** (you send the money yourself) or **Reject + refund**.
- **Star reactions** appear first in a post's reaction row (the ⭐ total), followed by the other reactions.
- **Admin → Stars → Switches & maintenance**: turn Top Up or Payout on/off, and switch the whole app into **Maintenance mode** (users see a notice; admins keep working).
- **SQL**: run `sql/17_stars_top_senders.sql` and `sql/18_stars_payouts.sql` after `16`.

### Stage G — Stories, reels & channels
- **Stories** (iOS style): glass header/pills, swipe-down to close, emoji reactions (❤️🔥😂😮😢👏) with flying-emoji animation, owner sees views + reactions; auto-advances to the next story/user. Run `sql/19_story_reactions.sql`.
- **Reels**: auto-next at the end (last reel replays); while a comment/options/tip/unlock sheet is open the reel loops instead of advancing. Paid-reel lock page is a blurred-preview glass card.
- **Telegram paid posts**: a channel post with Stars paid media is mirrored as a paid post (price = star_count); media can't be re-hosted by bots, so the card opens the message in Telegram to unlock.
- **Post as channel**: composer / reel upload has a "Post as" list (yourself or a linked channel you own); the post appears under that channel. Paid posts are always published as yourself.
