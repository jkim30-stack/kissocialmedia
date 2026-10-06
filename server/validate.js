// Server-side checks for uploads and text fields. The browser runs similar
// checks for fast feedback, but these are the ones that count.

export const ROLES = ['Student', 'Parent', 'Alumni', 'Teacher', 'Staff'];
export const CAPTION_MAX = 500;
export const NAME_MAX = 60;

// Vercel caps serverless request bodies at 4.5 MB, so stay under it.
export const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES) || 4 * 1024 * 1024;

// Identify the image type from the file's first bytes, not its name or the
// Content-Type the browser claims.
export function sniffImageType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: 'image/png', ext: 'png' };
  }
  const head6 = buf.subarray(0, 6).toString('ascii');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return { mime: 'image/gif', ext: 'gif' };
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp' };
  }
  return null;
}

export function validateImage(file) {
  if (!file || !file.buffer || file.size === 0) return { error: 'Add a photo before posting.' };
  if (file.size > MAX_UPLOAD_BYTES) return { error: `That photo is too big. The limit is ${formatMB(MAX_UPLOAD_BYTES)}.` };
  const type = sniffImageType(file.buffer);
  if (!type) return { error: 'That file is not a JPEG, PNG, WebP or GIF image.' };
  return { type };
}

export function validateCaption(raw) {
  const caption = typeof raw === 'string' ? raw.trim() : '';
  if (!caption) return { error: 'Write a caption. A sentence is plenty.' };
  if (caption.length > CAPTION_MAX) return { error: `Keep the caption under ${CAPTION_MAX} characters.` };
  return { caption };
}

export function validateDisplayName(raw) {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) return { error: 'Your name cannot be blank.' };
  if (name.length > NAME_MAX) return { error: `Keep your name under ${NAME_MAX} characters.` };
  return { name };
}

export function validateRole(raw) {
  return ROLES.includes(raw) ? { role: raw } : { error: 'Pick one of the listed roles.' };
}

export function formatMB(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(bytes % (1024 * 1024) === 0 ? 0 : 1)} MB`;
}
