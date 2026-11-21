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
