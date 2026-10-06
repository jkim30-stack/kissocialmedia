import express from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import {
  MAX_UPLOAD_BYTES, CAPTION_MAX, ROLES, formatMB,
  validateImage, validateCaption, validateDisplayName, validateRole,
} from './validate.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const BUCKET = 'media';
const PAGE_SIZE = 12;
const SIGNED_URL_TTL = 60 * 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUTHOR_COLUMNS = 'id, display_name, role, avatar_url';
const POST_COLUMNS = `id, caption, image_path, created_at, author:profiles!posts_author_id_fkey (${AUTHOR_COLUMNS})`;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5 },
});

// Every database and storage call runs as the signed-in user, so Postgres
// row-level security decides what they can read, create and delete.
function clientFor(token) {
  return createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function requireUser(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Sign in to continue.' });
  const sb = clientFor(token);
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data?.user) return res.status(401).json({ error: 'Your session has ended. Sign in again.' });
  req.user = data.user;
  req.sb = sb;
  next();
}

// Run multer and turn its errors into readable messages.
function singleImage(field) {
  const handler = upload.single(field);
  return (req, res, next) => handler(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `That photo is too big. The limit is ${formatMB(MAX_UPLOAD_BYTES)}.` });
    }
    return res.status(400).json({ error: 'The upload could not be read. Try a different file.' });
  });
}

// Swap stored image paths for short-lived signed URLs (the bucket is private).
async function signPaths(sb, paths) {
  const unique = [...new Set(paths.filter(Boolean))];
  if (!unique.length) return new Map();
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrls(unique, SIGNED_URL_TTL);
  if (error) throw error;
  return new Map(data.filter((d) => d.signedUrl).map((d) => [d.path, d.signedUrl]));
}

async function shapePosts(sb, rows) {
  const urls = await signPaths(sb, rows.flatMap((p) => [p.image_path, p.author?.avatar_url]));
  return rows.map((p) => ({
    id: p.id,
    caption: p.caption,
    created_at: p.created_at,
    image_url: urls.get(p.image_path) || null,
    author: p.author && {
      id: p.author.id,
      display_name: p.author.display_name,
      role: p.author.role,
      avatar_url: urls.get(p.author.avatar_url) || null,
    },
  }));
}

function pageQuery(query, before) {
  let q = query.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(PAGE_SIZE + 1);
  if (before && !Number.isNaN(Date.parse(before))) q = q.lt('created_at', before);
  return q;
}

function page(rows) {
  const hasMore = rows.length > PAGE_SIZE;
  const items = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
  return { items, next: hasMore ? items[items.length - 1].created_at : null };
}

const fail = (res, err, status = 500) => {
  console.error(err);
  res.status(status).json({ error: 'Something went wrong on our side. Try again in a moment.' });
};

export const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

app.get('/api/config', (_req, res) => {
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    return res.status(500).json({ error: 'The server is missing its Supabase settings.' });
  }
  res.json({
    supabaseUrl: SUPABASE_URL,
    supabaseKey: SUPABASE_PUBLISHABLE_KEY,
    maxUploadBytes: MAX_UPLOAD_BYTES,
    captionMax: CAPTION_MAX,
    roles: ROLES,
  });
});

app.get('/api/posts', requireUser, async (req, res) => {
  try {
    const { data, error } = await pageQuery(req.sb.from('posts').select(POST_COLUMNS), req.query.before);
    if (error) return fail(res, error);
    const { items, next } = page(data);
    res.json({ posts: await shapePosts(req.sb, items), next });
  } catch (err) { fail(res, err); }
});

app.post('/api/posts', requireUser, singleImage('image'), async (req, res) => {
  const img = validateImage(req.file);
  if (img.error) return res.status(400).json({ error: img.error });
  const cap = validateCaption(req.body?.caption);
  if (cap.error) return res.status(400).json({ error: cap.error });

  const path = `posts/${req.user.id}/${randomUUID()}.${img.type.ext}`;
  try {
    const up = await req.sb.storage.from(BUCKET).upload(path, req.file.buffer, {
      contentType: img.type.mime, upsert: false,
    });
    if (up.error) return fail(res, up.error);

    const { data, error } = await req.sb.from('posts')
      .insert({ author_id: req.user.id, image_path: path, caption: cap.caption })
      .select(POST_COLUMNS).single();
    if (error) {
      await req.sb.storage.from(BUCKET).remove([path]);
      return fail(res, error);
    }
    const [post] = await shapePosts(req.sb, [data]);
    res.status(201).json({ post });
  } catch (err) { fail(res, err); }
});

app.delete('/api/posts/:id', requireUser, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'That post does not exist.' });
  try {
    // RLS only lets authors delete their own rows, so a foreign post deletes nothing.
    const { data, error } = await req.sb.from('posts').delete().eq('id', req.params.id).select('id, image_path');
    if (error) return fail(res, error);
    if (!data.length) {
      const { data: exists } = await req.sb.from('posts').select('id').eq('id', req.params.id).maybeSingle();
      return exists
        ? res.status(403).json({ error: 'You can only delete your own posts.' })
        : res.status(404).json({ error: 'That post does not exist.' });
    }
    const rm = await req.sb.storage.from(BUCKET).remove([data[0].image_path]);
    if (rm.error) console.error('Post deleted but image removal failed', rm.error);
    res.json({ deleted: data[0].id });
  } catch (err) { fail(res, err); }
});

app.get('/api/profiles/:id', requireUser, async (req, res) => {
  const id = req.params.id === 'me' ? req.user.id : req.params.id;
  if (!UUID_RE.test(id)) return res.status(404).json({ error: 'We could not find that member.' });
  try {
    const { data: profile, error } = await req.sb.from('profiles')
      .select(`${AUTHOR_COLUMNS}, created_at`).eq('id', id).maybeSingle();
    if (error) return fail(res, error);
    if (!profile) return res.status(404).json({ error: 'We could not find that member.' });

    const postsRes = await pageQuery(req.sb.from('posts').select(POST_COLUMNS).eq('author_id', id), req.query.before);
    if (postsRes.error) return fail(res, postsRes.error);
    const { items, next } = page(postsRes.data);

    const urls = await signPaths(req.sb, [profile.avatar_url]);
    res.json({
      profile: { ...profile, avatar_url: urls.get(profile.avatar_url) || null, is_me: id === req.user.id },
      posts: await shapePosts(req.sb, items),
      next,
    });
  } catch (err) { fail(res, err); }
});

app.patch('/api/profile', requireUser, async (req, res) => {
  const name = validateDisplayName(req.body?.display_name);
  if (name.error) return res.status(400).json({ error: name.error });
  const role = validateRole(req.body?.role);
  if (role.error) return res.status(400).json({ error: role.error });
  const { error } = await req.sb.from('profiles')
    .update({ display_name: name.name, role: role.role }).eq('id', req.user.id);
  if (error) return fail(res, error);
  res.json({ ok: true });
});

app.post('/api/profile/avatar', requireUser, singleImage('avatar'), async (req, res) => {
  const img = validateImage(req.file);
  if (img.error) return res.status(400).json({ error: img.error === 'Add a photo before posting.' ? 'Choose a photo first.' : img.error });
  try {
    const { data: current } = await req.sb.from('profiles').select('avatar_url').eq('id', req.user.id).single();
    const path = `avatars/${req.user.id}/${randomUUID()}.${img.type.ext}`;
    const up = await req.sb.storage.from(BUCKET).upload(path, req.file.buffer, { contentType: img.type.mime });
    if (up.error) return fail(res, up.error);
    const { error } = await req.sb.from('profiles').update({ avatar_url: path }).eq('id', req.user.id);
    if (error) {
      await req.sb.storage.from(BUCKET).remove([path]);
      return fail(res, error);
    }
    if (current?.avatar_url) await req.sb.storage.from(BUCKET).remove([current.avatar_url]);
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));
