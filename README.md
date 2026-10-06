# The KIS Social

A members-only photo feed for the KIS community: students, parents, alumni, teachers and staff. Sign up, post a photo with a caption, and read the front page.

- **Front end:** plain HTML, CSS and JavaScript in `public/` (no build step)
- **API:** Node.js + Express in `server/`, deployed to Vercel as a serverless function (`api/index.js`)
- **Backend:** Supabase for auth, Postgres (profiles, posts) and Storage (private `media` bucket)

## How it works

- The browser signs users in with Supabase Auth using the **publishable** key.
- Every API call sends the user's access token. The server makes all database and storage calls **as that user**, so Postgres row-level security decides what they may do. The server never holds a service-role key.
- Uploads go through the server, which checks the real file type from the file's bytes (JPEG, PNG, WebP, GIF), the size (4 MB by default) and the caption (1 to 500 characters) before storing anything.
- The `media` bucket is private. The feed returns signed image links that expire after an hour.
- Only signed-in members can see the feed, profiles or images.

## Database

The schema is in `supabase/migrations/20261006000000_kis_social_schema.sql`:

| Object | Rules |
| --- | --- |
| `profiles` | Created automatically on sign-up from the name and role entered. Members can read all; users update only their own. |
| `posts` | Members can read all; users insert as themselves and delete only their own. No edits. |
| `media` bucket | Private, 5 MB cap, images only. Files live at `posts/<user-id>/…` and `avatars/<user-id>/…`; users write and delete only in their own folder. |

## Run it locally

Requires Node 22 or newer.

```bash
npm install
cp .env.example .env   # then fill in SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY
npm run dev
```

Open http://localhost:3000.

To use a fresh Supabase project, run the migration file in the Supabase SQL editor first.

## Environment variables

| Name | Required | Notes |
| --- | --- | --- |
| `SUPABASE_URL` | Yes | Project URL, from Project Settings > API |
| `SUPABASE_PUBLISHABLE_KEY` | Yes | `sb_publishable_…` key. Safe to expose; RLS protects the data. |
| `MAX_UPLOAD_BYTES` | No | Default 4194304 (4 MB). Keep it under 4.5 MB on Vercel. |
| `PORT` | No | Local only. Default 3000. |

Never add the service-role or secret key. This app does not need it.

## Tests

The API tests run against any running copy of the site and need two **confirmed** test accounts in a JSON file kept outside the repo:

```json
{ "a": { "email": "...", "password": "..." }, "b": { "email": "...", "password": "..." } }
```

```bash
BASE_URL=http://localhost:3000 TEST_USERS=/path/to/test-users.json npm test
```

They cover: signed-out access is blocked, upload shows up in the feed, storage and profile, another member cannot delete your post or touch your files, and bad uploads (no image, oversized, wrong type, renamed text file, blank or long caption) are rejected.

## Deploying to Vercel

1. Import the GitHub repo in Vercel. `vercel.json` already sets the output directory (`public`), an empty build command and the `/api` rewrite. Node version comes from `engines` in `package.json`.
2. Add `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` for Production and Preview.
3. In Supabase, go to Authentication > URL Configuration. Set **Site URL** to your Vercel domain and add `https://<your-domain>/**` (and `https://*-<your-team>.vercel.app/**` for previews) to **Redirect URLs**. Confirmation emails link back here.

## Going live checklist

- Set up custom SMTP in Supabase (Authentication > Emails). The built-in sender only delivers to your own team's addresses and is heavily rate limited, so real members will not receive confirmation emails without it.
- Decide who may join. Right now anyone with an email can sign up. To limit it to school addresses, add a sign-up hook or an allow-list.
- Write a short community guideline and a way to report posts. There is no moderation tool yet.
