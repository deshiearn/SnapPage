-- ================= Fix: comments.post_id type mismatch (Shorts video comments) =================
-- Run this once in the Supabase SQL editor.
--
-- Symptom: commenting on a Shorts video fails with
--   "invalid input syntax for type uuid: \"3\""
--
-- Cause: comments.post_id was created as type `uuid` (to match posts.id, which is a uuid),
-- with a foreign key constraint tying it to posts.id. But videos.id is a bigint
-- (e.g. 3, 42, ...), so it can never be stored in a uuid column or satisfy that FK.
--
-- Fix: drop the old foreign key (comments now serve both posts and videos, so a single FK to
-- posts.id no longer applies — content_type is what tells them apart), then widen
-- comments.post_id to `text`, which can safely hold both a post's uuid string and a video's
-- bigint-as-string, with no data loss for existing comments.

alter table comments drop constraint if exists comments_post_id_fkey;
alter table comments alter column post_id type text using post_id::text;
