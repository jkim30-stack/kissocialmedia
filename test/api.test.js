// End-to-end API checks against a running deployment.
//
//   BASE_URL=http://localhost:3000 TEST_USERS=./test-users.json npm test
//
// TEST_USERS points to a JSON file with two confirmed accounts:
//   { "a": { "email": "...", "password": "..." }, "b": { "email": "...", "password": "..." } }
// Keep that file out of git.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { sniffImageType } from '../server/validate.js';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const users = process.env.TEST_USERS ? JSON.parse(readFileSync(process.env.TEST_USERS, 'utf8')) : null;

// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

let config;
const sessions = {};
const created = [];

async function call(path, { token, method = 'GET', form, json } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (json) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: form || (json && JSON.stringify(json)) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function imageForm(buf, name, type, caption) {
  const fd = new FormData();
  if (buf) fd.append('image', new Blob([buf], { type }), name);
  if (caption !== undefined) fd.append('caption', caption);
  return fd;
}

before(async () => {
  config = (await call('/api/config')).body;
  if (!users) return;
  for (const key of ['a', 'b']) {
    const sb = createClient(config.supabaseUrl, config.supabaseKey, { auth: { persistSession: false } });
    const { data, error } = await sb.auth.signInWithPassword(users[key]);
    if (error) throw error;
    sessions[key] = { sb, token: data.session.access_token, id: data.user.id };
  }
});

after(async () => {
  for (const { id, token } of created) await call(`/api/posts/${id}`, { method: 'DELETE', token });
  for (const s of Object.values(sessions)) await s.sb.auth.signOut();
});

test('file sniffing recognises real images and rejects text', () => {
  assert.equal(sniffImageType(PNG)?.mime, 'image/png');
  assert.equal(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))?.mime, 'image/jpeg');
  assert.equal(sniffImageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'binary'))?.mime, 'image/webp');
  assert.equal(sniffImageType(Buffer.from('hello world, not an image')), null);
});

test('config is served and holds no secret keys', async () => {
  assert.ok(config.supabaseUrl.startsWith('https://'));
  assert.ok(!/service_role|sb_secret_/.test(JSON.stringify(config)));
});

test('signed-out visitors cannot read the feed or post', async () => {
  assert.equal((await call('/api/posts')).status, 401);
  assert.equal((await call('/api/posts', { method: 'POST', form: imageForm(PNG, 'a.png', 'image/png', 'hi') })).status, 401);
});

test('signed-out visitors cannot read posts straight from Supabase', async () => {
  const anon = createClient(config.supabaseUrl, config.supabaseKey, { auth: { persistSession: false } });
  const { data } = await anon.from('posts').select('id').limit(1);
  assert.deepEqual(data, []);
});

test('upload, see it in feed and storage, then delete', { skip: !users }, async () => {
  const { token, sb, id } = sessions.a;
  const caption = `Test post ${Date.now()} [placeholder, safe to delete]`;
  const res = await call('/api/posts', { method: 'POST', token, form: imageForm(PNG, 'pixel.png', 'image/png', caption) });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const post = res.body.post;
  created.push({ id: post.id, token });

  const feed = await call('/api/posts', { token: sessions.b.token });
  assert.equal(feed.status, 200);
  const inFeed = feed.body.posts.find((p) => p.id === post.id);
  assert.ok(inFeed, 'new post should be in the feed');
  assert.equal(inFeed.caption, caption);
  assert.equal(feed.body.posts[0].id, post.id, 'newest post should be first');

  const img = await fetch(inFeed.image_url);
  assert.equal(img.status, 200, 'signed image URL should load');

  const { data: files } = await sb.storage.from('media').list(`posts/${id}`);
  assert.ok(files.length >= 1, 'image should be in the storage bucket');

  const profile = await call(`/api/profiles/${id}`, { token });
  assert.ok(profile.body.posts.some((p) => p.id === post.id), 'post should show on the author profile');

  // Another member cannot delete it, through the API or directly.
  const foreign = await call(`/api/posts/${post.id}`, { method: 'DELETE', token: sessions.b.token });
  assert.equal(foreign.status, 403);
  const direct = await sessions.b.sb.from('posts').delete().eq('id', post.id).select();
  assert.deepEqual(direct.data, []);
  const directFile = await sessions.b.sb.storage.from('media').remove([`posts/${id}/${files[0].name}`]);
  assert.deepEqual(directFile.data, []);

  const del = await call(`/api/posts/${post.id}`, { method: 'DELETE', token });
  assert.equal(del.status, 200);
  created.pop();
  const after = await call('/api/posts', { token });
  assert.ok(!after.body.posts.some((p) => p.id === post.id));
  const { data: filesAfter } = await sb.storage.from('media').list(`posts/${id}`);
  assert.ok(!filesAfter.some((f) => f.name === files[0].name), 'image should be removed from storage');
});

test('bad uploads are rejected by the server', { skip: !users }, async () => {
  const { token } = sessions.a;
  const noImage = await call('/api/posts', { method: 'POST', token, form: imageForm(null, null, null, 'caption only') });
  assert.equal(noImage.status, 400);
  assert.match(noImage.body.error, /Add a photo/);

  const big = Buffer.concat([PNG, Buffer.alloc(config.maxUploadBytes)]);
  const tooBig = await call('/api/posts', { method: 'POST', token, form: imageForm(big, 'big.png', 'image/png', 'big') });
  assert.equal(tooBig.status, 413);

  const text = await call('/api/posts', { method: 'POST', token, form: imageForm(Buffer.from('just some text, honest'), 'notes.txt', 'text/plain', 'x') });
  assert.equal(text.status, 400);
  assert.match(text.body.error, /not a JPEG/);

  const spoofed = await call('/api/posts', { method: 'POST', token, form: imageForm(Buffer.from('<?php echo 1; ?> not really a png'), 'evil.png', 'image/png', 'x') });
  assert.equal(spoofed.status, 400, 'renamed text file should be rejected');

  const blank = await call('/api/posts', { method: 'POST', token, form: imageForm(PNG, 'a.png', 'image/png', '   ') });
  assert.equal(blank.status, 400);
  assert.match(blank.body.error, /caption/);

  const long = await call('/api/posts', { method: 'POST', token, form: imageForm(PNG, 'a.png', 'image/png', 'x'.repeat(501)) });
  assert.equal(long.status, 400);
});

test('members cannot write into another member\'s storage folder or edit their profile', { skip: !users }, async () => {
  const { sb } = sessions.b;
  const up = await sb.storage.from('media').upload(`posts/${sessions.a.id}/intruder.png`, PNG, { contentType: 'image/png' });
  assert.ok(up.error, 'upload into someone else\'s folder must fail');
  const { data } = await sb.from('profiles').update({ display_name: 'Hacked' }).eq('id', sessions.a.id).select();
  assert.deepEqual(data, []);
});

test('profile edits are validated', { skip: !users }, async () => {
  const { token } = sessions.a;
  assert.equal((await call('/api/profile', { method: 'PATCH', token, json: { display_name: '', role: 'Student' } })).status, 400);
  assert.equal((await call('/api/profile', { method: 'PATCH', token, json: { display_name: 'Test Member A', role: 'Principal' } })).status, 400);
  assert.equal((await call('/api/profile', { method: 'PATCH', token, json: { display_name: 'Test Member A', role: 'Student' } })).status, 200);
});
