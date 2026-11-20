import { put, del } from '@vercel/blob';
import crypto from 'crypto';
import path from 'path';
import { prisma } from './db.js';

// Content-Type is decided HERE from a whitelist — never from the client (blocks html/svg uploads)
const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', m4a: 'audio/mp4', wav: 'audio/wav', aac: 'audio/aac',
};
const IMAGE = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);
const VIDEO = new Set(['mp4', 'webm', 'mov']);

export async function saveFile(file, userId) {
  if (!userId) throw new Error('userId required');
  const ext = path.extname(file.originalname || '').slice(1).toLowerCase();
  if (!MIME[ext]) throw new Error('Allowed: jpg png gif webp mp4 webm mov mp3 ogg m4a wav aac');
  const type = IMAGE.has(ext) ? 'IMAGE' : VIDEO.has(ext) && !file.mimetype.startsWith('audio/') ? 'VIDEO' : 'VOICE';
  const blob = await put(`uploads/${userId}/${crypto.randomBytes(16).toString('hex')}.${ext}`, file.buffer, {
    access: 'public', contentType: MIME[ext], addRandomSuffix: false,
  });
  return { type, fileUrl: blob.url, fileName: String(file.originalname || '').slice(0, 200), fileSize: file.size };
}

// Only accept file URLs that were uploaded by THIS user to OUR Blob store.
// Token format: vercel_blob_rw_<storeId>_<secret>  →  host <storeid>.public.blob.vercel-storage.com
const STORE_ID = (process.env.BLOB_READ_WRITE_TOKEN || '').split('_')[3]?.toLowerCase();
export function isBlobUrl(u, userId) {
  try {
    const x = new URL(u);
    // In production the token MUST identify our store, otherwise any Blob store would be accepted
    if (!STORE_ID && process.env.NODE_ENV === 'production') return false;
    const host = STORE_ID ? `${STORE_ID}.public.blob.vercel-storage.com` : null;
    const hostOk = host ? x.hostname === host : x.hostname.endsWith('.public.blob.vercel-storage.com');
    const pathOk = userId ? x.pathname.startsWith(`/uploads/${userId}/`) : x.pathname.startsWith('/uploads/');
    return x.protocol === 'https:' && hostOk && pathOk;
  } catch { return false; }
}

export const removeFile = (url) => (isBlobUrl(url) ? del(url).catch(() => {}) : Promise.resolve());

// Same file URL can be reused by several messages / an avatar → only delete when nothing references it anymore
export async function removeFileIfUnused(url) {
  if (!url || !isBlobUrl(url)) return;
  const [msgs, users, chats, posts] = await Promise.all([
    prisma.message.count({ where: { fileUrl: url } }),
    prisma.user.count({ where: { avatarUrl: url } }),
    prisma.chat.count({ where: { avatarUrl: url } }),
    prisma.post.count({ where: { imageUrl: url } }),
  ]);
  if (!msgs && !users && !chats && !posts) await removeFile(url);
}
