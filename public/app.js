import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const view = document.getElementById('view');
const nav = document.getElementById('nav');
const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

let config;
let supabase;
let session = null;
let renderToken = 0;

// Helpers ------------------------------------------------------------------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const mb = (bytes) => `${(bytes / 1048576).toFixed(bytes % 1048576 ? 1 : 0)} MB`;

const dateFmt = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' });
const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
function when(iso) {
  const d = new Date(iso);
  const mins = Math.round((d - Date.now()) / 60000);
  if (mins > -1) return 'just now';
  if (mins > -60) return rtf.format(mins, 'minute');
  if (mins > -60 * 24) return rtf.format(Math.round(mins / 60), 'hour');
  if (mins > -60 * 24 * 7) return rtf.format(Math.round(mins / 1440), 'day');
  return dateFmt.format(d);
}

const initials = (name) => esc((name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase());

function toast(msg) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = msg;
  document.body.append(el);
  setTimeout(() => el.remove(), 3200);
}

async function api(path, { method = 'GET', body, form } = {}) {
  const headers = {};
  const token = session?.access_token;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(path, { method, headers, body: form || (body && JSON.stringify(body)) });
  } catch {
    throw new Error('We could not reach the server. Check your connection and try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && session) {
    await supabase.auth.signOut();
    throw new Error(data.error || 'Your session has ended. Sign in again.');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

function loadingState() {
  return `<div class="loading" aria-busy="true" aria-label="Loading">
    <div class="bar w40"></div><div class="bar tall"></div><div class="bar w60"></div><div class="bar"></div>
  </div>`;
}

function errorState(message, retry = true) {
  return `<section class="state" role="alert">
    <span class="kicker">Stop the presses</span>
    <h2>That did not load.</h2>
    <p>${esc(message)}</p>
    ${retry ? '<button class="btn btn--ghost" data-action="retry">Try again</button>' : ''}
  </section>`;
}

// Navigation ---------------------------------------------------------------

function renderNav(route) {
  const link = (href, label, key) =>
    `<a href="${href}"${route === key ? ' aria-current="page"' : ''}>${label}</a>`;
  nav.innerHTML = session
    ? link('#/', 'Front page', 'feed') + link('#/new', 'Post a photo', 'new') +
      link('#/u/me', 'Your page', 'me') + '<button type="button" data-action="signout">Sign out</button>'
    : link('#/login', 'Sign in', 'login') + link('#/signup', 'Join', 'signup');
}

nav.addEventListener('click', async (e) => {
  if (e.target.closest('[data-action="signout"]')) {
    await supabase.auth.signOut();
    location.hash = '#/login';
  }
});

// Auth views ---------------------------------------------------------------

function authLede() {
  return `<div class="split__lede">
    <span class="kicker">Members only</span>
    <h1>The school year, as seen by the people living it.</h1>
    <p>Students, parents, alumni, teachers and staff post photos from KIS life. Only signed-in members can see the feed.</p>
    <ol>
      <li><span>Make an account with your email and pick your role.</span></li>
      <li><span>Confirm your address from the email we send you.</span></li>
      <li><span>Post a photo with a line or two about what happened.</span></li>
    </ol>
  </div>`;
}

function renderLogin(msg = '') {
  view.innerHTML = `<div class="split">
    ${authLede()}
    <section>
      <div class="section-head"><h2>Sign in</h2></div>
      <form class="form" id="login-form" novalidate>
        <div class="notice ${msg ? 'notice--ok' : ''}" id="form-msg" role="status">${esc(msg)}</div>
        <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required></div>
        <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required></div>
        <button class="btn" type="submit">Sign in</button>
        <p class="auth-switch">New here? <a href="#/signup">Create an account</a>.</p>
      </form>
    </section>
  </div>`;

  const form = document.getElementById('login-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = document.getElementById('form-msg');
    const email = form.email.value.trim();
    const password = form.password.value;
    if (!email || !password) return showError(out, 'Enter your email and password.');
    const btn = form.querySelector('button');
    btn.disabled = true; btn.textContent = 'Signing in';
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    btn.disabled = false; btn.textContent = 'Sign in';
    if (error) {
      const text = /confirm/i.test(error.message)
        ? 'Confirm your email first. Check your inbox for the link we sent.'
        : /invalid/i.test(error.message) ? 'That email and password do not match.' : error.message;
      return showError(out, text);
    }
    location.hash = '#/';
  });
}

function renderSignup() {
  const roles = config.roles.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join('');
  view.innerHTML = `<div class="split">
    ${authLede()}
    <section>
      <div class="section-head"><h2>Join the paper</h2></div>
      <form class="form" id="signup-form" novalidate>
        <div class="notice" id="form-msg" role="status"></div>
        <div class="field"><label for="display_name">Your name</label><input id="display_name" name="display_name" maxlength="60" autocomplete="name" required></div>
        <div class="field"><label for="role">You are a</label><select id="role" name="role" required><option value="">Choose one</option>${roles}</select></div>
        <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required></div>
        <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="new-password" minlength="8" required><span class="hint">At least 8 characters.</span></div>
        <button class="btn" type="submit">Create account</button>
        <p class="auth-switch">Already a member? <a href="#/login">Sign in</a>.</p>
      </form>
    </section>
  </div>`;

  const form = document.getElementById('signup-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = document.getElementById('form-msg');
    const display_name = form.display_name.value.trim();
    const role = form.role.value;
    const email = form.email.value.trim();
    const password = form.password.value;
    if (!display_name) return showError(out, 'Tell us your name.');
    if (!config.roles.includes(role)) return showError(out, 'Pick the role that fits you best.');
    if (!/^\S+@\S+\.\S+$/.test(email)) return showError(out, 'That email address does not look right.');
    if (password.length < 8) return showError(out, 'Use a password with at least 8 characters.');

    const btn = form.querySelector('button');
    btn.disabled = true; btn.textContent = 'Creating account';
    const { data, error } = await supabase.auth.signUp({
      email, password,
      options: { data: { display_name, role }, emailRedirectTo: `${location.origin}/` },
    });
    btn.disabled = false; btn.textContent = 'Create account';
    if (error) return showError(out, error.message);
    if (data.session) { location.hash = '#/'; return; }
    view.innerHTML = `<section class="state">
      <span class="kicker">One more step</span>
      <h2>Check your inbox.</h2>
      <p>We sent a confirmation link to <strong>${esc(email)}</strong>. Open it on this device, then sign in.</p>
      <a class="btn btn--ghost" href="#/login">Go to sign in</a>
    </section>`;
  });
}

function showError(el, text) {
  el.className = 'notice notice--error';
  el.textContent = text;
  el.focus?.();
}

// Feed ---------------------------------------------------------------------

const PATTERN = [
  ['s7', 'row-start'], ['s5', 'row-end'],
  ['s4', 'row-start'], ['s4', ''], ['s4', 'row-end'],
  ['s5', 'row-start'], ['s7', 'row-end'],
];

function storyHTML(post, cls = '', { showAuthor = true } = {}) {
  const mine = post.author?.id === session?.user.id;
  const media = post.image_url
    ? `<img src="${esc(post.image_url)}" alt="${esc(`Photo posted by ${post.author?.display_name ?? 'a member'}`)}" loading="lazy">`
    : '<span class="missing">Photo unavailable</span>';
  return `<article class="story ${cls}" data-post="${esc(post.id)}">
    <div class="story__media">${media}</div>
    <div class="story__body">
      <div class="byline">
        ${showAuthor ? `<a href="#/u/${esc(post.author?.id)}">${esc(post.author?.display_name ?? 'Former member')}</a>
        <span class="kicker">${esc(post.author?.role ?? '')}</span>` : ''}
        <time datetime="${esc(post.created_at)}" title="${esc(new Date(post.created_at).toLocaleString())}">${esc(when(post.created_at))}</time>
      </div>
      <p class="story__caption">${esc(post.caption)}</p>
      ${mine ? '<div class="story__tools"><button class="linkish" data-action="delete">Delete this post</button></div>' : ''}
    </div>
  </article>`;
}

async function renderFeed(token) {
  view.innerHTML = loadingState();
  let data;
  try {
    data = await api('/api/posts');
  } catch (err) {
    if (token !== renderToken) return;
    view.innerHTML = errorState(err.message);
    return;
  }
  if (token !== renderToken) return;

  if (!data.posts.length) {
    view.innerHTML = `<section class="state">
      <span class="kicker">Front page</span>
      <h2>Nothing on the front page yet.</h2>
      <p>No one has posted. Share a photo from a game, a class, a trip or a quiet corner of campus and you will be the lead story.</p>
      <a class="btn" href="#/new">Post the first photo</a>
    </section>`;
    return;
  }

  const [lead, ...rest] = data.posts;
  view.innerHTML = `
    ${storyHTML(lead, 'lead')}
    <div class="section-head"><h2>Latest from campus</h2><span class="kicker">Newest first</span></div>
    <div class="grid" id="grid"></div>
    <div class="more" id="more"></div>`;

  const grid = document.getElementById('grid');
  let index = 0;
  const append = (posts) => {
    grid.insertAdjacentHTML('beforeend', posts.map((p) => {
      const [size, edge] = PATTERN[index++ % PATTERN.length];
      return storyHTML(p, `${size} ${edge}`);
    }).join(''));
  };
  append(rest);
  if (!rest.length) grid.previousElementSibling.remove();
  setupMore(data.next, async (before) => {
    const next = await api(`/api/posts?before=${encodeURIComponent(before)}`);
    if (!grid.isConnected) return null;
    if (next.posts.length && !grid.previousElementSibling) {
      grid.insertAdjacentHTML('beforebegin', '<div class="section-head"><h2>Latest from campus</h2><span class="kicker">Newest first</span></div>');
    }
    append(next.posts);
    return next.next;
  });
}

function setupMore(next, loadPage) {
  const more = document.getElementById('more');
  const draw = (cursor, err = '') => {
    more.innerHTML = cursor
      ? `<div style="display:grid;gap:10px;justify-items:center">
          ${err ? `<p class="notice notice--error">${esc(err)}</p>` : ''}
          <button class="btn btn--ghost" type="button">Load more</button></div>`
      : '';
    const btn = more.querySelector('button');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.textContent = 'Loading';
      try {
        const cursorNext = await loadPage(cursor);
        if (cursorNext !== null || more.isConnected) draw(cursorNext);
      } catch (e) {
        draw(cursor, e.message);
      }
    });
  };
  draw(next);
}

// Delete (works on any page with stories) -----------------------------------

view.addEventListener('click', async (e) => {
  if (e.target.closest('[data-action="retry"]')) return route();
  const del = e.target.closest('[data-action="delete"]');
  if (!del) return;
  const story = del.closest('[data-post]');
  if (!confirm('Delete this post? The photo will be removed for everyone.')) return;
  del.disabled = true; del.textContent = 'Deleting';
  try {
    await api(`/api/posts/${story.dataset.post}`, { method: 'DELETE' });
    toast('Post deleted.');
    if (story.classList.contains('lead') || !document.querySelector('[data-post]:not([data-post="' + story.dataset.post + '"])')) {
      route();
    } else {
      story.remove();
      const count = document.getElementById('post-count');
      if (count) count.textContent = Math.max(0, Number(count.textContent) - 1);
    }
  } catch (err) {
    del.disabled = false; del.textContent = 'Delete this post';
    toast(err.message);
  }
});

// Composer -----------------------------------------------------------------

function renderCompose() {
  view.innerHTML = `<div class="composer">
    <section>
      <div class="section-head"><h2>Post a photo</h2><span class="kicker">Step 1</span></div>
      <div id="picker">
        <label class="dropzone" id="dropzone">
          <input type="file" id="file" accept="${ACCEPTED.join(',')}">
          <span><span class="dropzone__label">Choose a photo</span>
          <span class="dropzone__sub" style="display:block">or drop one here. JPEG, PNG, WebP or GIF, up to ${mb(config.maxUploadBytes)}.</span></span>
        </label>
      </div>
    </section>
    <section>
      <div class="section-head"><h2>Say what happened</h2><span class="kicker">Step 2</span></div>
      <form class="form" id="post-form" novalidate>
        <div class="notice" id="form-msg" role="status"></div>
        <div class="field">
          <label for="caption">Caption</label>
          <textarea id="caption" name="caption" maxlength="${config.captionMax + 50}" placeholder="Who, what, where. A sentence is plenty."></textarea>
          <span class="hint" id="count">0 / ${config.captionMax}</span>
        </div>
        <button class="btn" type="submit">Publish to the front page</button>
      </form>
    </section>
  </div>`;

  let file = null;
  let previewUrl = null;
  const picker = document.getElementById('picker');
  const out = document.getElementById('form-msg');
  const caption = document.getElementById('caption');
  const count = document.getElementById('count');

  const checkFile = (f) => {
    if (!f) return 'Add a photo before posting.';
    if (!ACCEPTED.includes(f.type)) return 'That file is not a JPEG, PNG, WebP or GIF image.';
    if (f.size > config.maxUploadBytes) return `That photo is ${mb(f.size)}. The limit is ${mb(config.maxUploadBytes)}.`;
    return '';
  };

  const showPicker = () => {
    picker.innerHTML = `<label class="dropzone" id="dropzone">
      <input type="file" id="file" accept="${ACCEPTED.join(',')}">
      <span><span class="dropzone__label">Choose a photo</span>
      <span class="dropzone__sub" style="display:block">or drop one here. JPEG, PNG, WebP or GIF, up to ${mb(config.maxUploadBytes)}.</span></span>
    </label>`;
    bindPicker();
  };

  const choose = (f) => {
    const problem = checkFile(f);
    if (problem) { showError(out, problem); return; }
    out.className = 'notice'; out.textContent = '';
    file = f;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(f);
    picker.innerHTML = `<figure class="preview" style="margin:0">
      <img src="${previewUrl}" alt="Preview of the photo you chose">
      <figcaption class="preview__meta"><span>${esc(f.name)} · ${mb(f.size)}</span>
      <button type="button" class="linkish" id="swap">Choose a different photo</button></figcaption>
    </figure>`;
    document.getElementById('swap').addEventListener('click', () => { file = null; showPicker(); });
  };

  function bindPicker() {
    const zone = document.getElementById('dropzone');
    document.getElementById('file').addEventListener('change', (e) => choose(e.target.files[0]));
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
    zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('drag'); choose(e.dataTransfer.files[0]); });
  }
  bindPicker();

  caption.addEventListener('input', () => {
    const n = caption.value.trim().length;
    count.textContent = `${n} / ${config.captionMax}`;
    count.classList.toggle('over', n > config.captionMax);
  });

  document.getElementById('post-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = caption.value.trim();
    const problem = checkFile(file);
    if (problem) return showError(out, problem);
    if (!text) return showError(out, 'Write a caption. A sentence is plenty.');
    if (text.length > config.captionMax) return showError(out, `Keep the caption under ${config.captionMax} characters.`);

    const form = new FormData();
    form.append('image', file);
    form.append('caption', text);
    const btn = e.submitter || e.target.querySelector('button[type="submit"]');
    btn.disabled = true; btn.textContent = 'Publishing';
    try {
      await api('/api/posts', { method: 'POST', form });
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      toast('Posted. You are on the front page.');
      location.hash = '#/';
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Publish to the front page';
      showError(out, err.message);
    }
  });
}

// Profile ------------------------------------------------------------------

async function renderProfile(id, token) {
  view.innerHTML = loadingState();
  let data;
  try {
    data = await api(`/api/profiles/${encodeURIComponent(id)}`);
  } catch (err) {
    if (token !== renderToken) return;
    view.innerHTML = errorState(err.message, !/could not find/i.test(err.message));
    return;
  }
  if (token !== renderToken) return;

  const { profile, posts, next } = data;
  const roles = config.roles.map((r) => `<option${r === profile.role ? ' selected' : ''}>${esc(r)}</option>`).join('');
  const since = new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric' }).format(new Date(profile.created_at));

  view.innerHTML = `
    <header class="profile-head">
      <div class="avatar">${profile.avatar_url ? `<img src="${esc(profile.avatar_url)}" alt="">` : initials(profile.display_name)}</div>
      <div>
        <span class="kicker">${esc(profile.role)}</span>
        <h1>${esc(profile.display_name)}</h1>
        <div class="meta">Member since ${esc(since)}</div>
      </div>
      <div class="profile-stat"><strong id="post-count">${posts.length}${next ? '+' : ''}</strong><span>Posts</span></div>
    </header>
    ${profile.is_me ? `<details class="edit-profile">
      <summary>Edit your profile</summary>
      <form class="form" id="profile-form" novalidate>
        <div class="notice full" id="form-msg" role="status"></div>
        <div class="field"><label for="display_name">Name</label><input id="display_name" name="display_name" maxlength="60" value="${esc(profile.display_name)}"></div>
        <div class="field"><label for="role">Role</label><select id="role" name="role">${roles}</select></div>
        <div class="field full"><label for="avatar">New profile photo (optional)</label><input id="avatar" name="avatar" type="file" accept="${ACCEPTED.join(',')}"><span class="hint">Square photos look best. Up to ${mb(config.maxUploadBytes)}.</span></div>
        <div class="full"><button class="btn" type="submit">Save changes</button></div>
      </form>
    </details>` : ''}
    <div class="section-head"><h2>${profile.is_me ? 'Your posts' : `Posts by ${esc(profile.display_name.split(' ')[0])}`}</h2></div>
    ${posts.length ? '<div class="grid" id="grid"></div><div class="more" id="more"></div>' : `<section class="state">
      <h2>${profile.is_me ? 'You have not posted yet.' : 'No posts yet.'}</h2>
      <p>${profile.is_me ? 'Your photos will show up here once you share one.' : 'When they share a photo, it will show up here.'}</p>
      ${profile.is_me ? '<a class="btn" href="#/new">Post a photo</a>' : ''}
    </section>`}`;

  if (posts.length) {
    const grid = document.getElementById('grid');
    let index = 2; // start on the three-up row
    const append = (list) => grid.insertAdjacentHTML('beforeend', list.map((p) => {
      const [size, edge] = PATTERN[index++ % PATTERN.length];
      return storyHTML(p, `${size} ${edge}`, { showAuthor: false });
    }).join(''));
    append(posts);
    setupMore(next, async (before) => {
      const more = await api(`/api/profiles/${encodeURIComponent(id)}?before=${encodeURIComponent(before)}`);
      append(more.posts);
      return more.next;
    });
  }

  if (profile.is_me) bindProfileForm();
}

function bindProfileForm() {
  const form = document.getElementById('profile-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = document.getElementById('form-msg');
    const display_name = form.display_name.value.trim();
    const role = form.role.value;
    const avatar = form.avatar.files[0];
    if (!display_name) return showError(out, 'Your name cannot be blank.');
    if (avatar && !ACCEPTED.includes(avatar.type)) return showError(out, 'That file is not a JPEG, PNG, WebP or GIF image.');
    if (avatar && avatar.size > config.maxUploadBytes) return showError(out, `That photo is ${mb(avatar.size)}. The limit is ${mb(config.maxUploadBytes)}.`);
    const btn = form.querySelector('button');
    btn.disabled = true; btn.textContent = 'Saving';
    try {
      await api('/api/profile', { method: 'PATCH', body: { display_name, role } });
      if (avatar) {
        const fd = new FormData();
        fd.append('avatar', avatar);
        await api('/api/profile/avatar', { method: 'POST', form: fd });
      }
      toast('Profile saved.');
      route();
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Save changes';
      showError(out, err.message);
    }
  });
}

// Router -------------------------------------------------------------------

function route() {
  const token = ++renderToken;
  const hash = location.hash.replace(/^#/, '') || '/';
  const [, section, param] = hash.split('/');
  const publicRoutes = ['login', 'signup'];

  if (!session && !publicRoutes.includes(section)) {
    renderNav('login');
    renderLogin();
    return;
  }
  if (session && publicRoutes.includes(section)) {
    location.replace('#/');
    return;
  }

  const key = section === 'u' && param === 'me' ? 'me' : section || 'feed';
  renderNav(key);
  view.focus({ preventScroll: true });
  window.scrollTo(0, 0);

  if (section === 'login') return renderLogin();
  if (section === 'signup') return renderSignup();
  if (section === 'new') return renderCompose();
  if (section === 'u' && param) return renderProfile(param, token);
  return renderFeed(token);
}

// Boot ---------------------------------------------------------------------

document.getElementById('dateline').textContent =
  new Intl.DateTimeFormat('en', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date());

async function boot() {
  view.innerHTML = loadingState();
  try {
    const res = await fetch('/api/config');
    config = await res.json();
    if (!res.ok) throw new Error(config.error);
  } catch (err) {
    view.innerHTML = errorState(err.message || 'The site could not start.');
    return;
  }
  supabase = createClient(config.supabaseUrl, config.supabaseKey);
  const { data } = await supabase.auth.getSession();
  session = data.session;

  supabase.auth.onAuthStateChange((event, next) => {
    const was = session?.user.id;
    session = next;
    if (event === 'SIGNED_IN' && was !== next?.user.id) route();
    if (event === 'SIGNED_OUT') route();
  });

  window.addEventListener('hashchange', route);
  route();
}

boot();
