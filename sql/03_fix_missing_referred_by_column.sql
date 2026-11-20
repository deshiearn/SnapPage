-- ================= Fix: 'users' table is missing the 'referred_by' column =================
-- Run this once in the Supabase SQL editor. This is the real root cause of "User not found",
-- referral counts never updating, channel add failing, and posts failing — the app has been
-- trying to insert a `referred_by` value into every new user row, but the column has never
-- actually existed in this table. PostgREST rejects the whole insert whenever that happens,
-- so NO new users could ever be created (except however the very first row got in, e.g. by
-- being added manually).
--
-- Confirmed directly from the Render logs:
--   "Could not find the 'referred_by' column of 'users' in the schema cache"

alter table users add column if not exists referred_by text;
