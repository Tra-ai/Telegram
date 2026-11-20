import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../auth.js';
import { saveFile } from '../storage.js';

const signatures = {
  jpg: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  jpeg: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  png: (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])),
  gif: (b) => b.subarray(0, 6).toString('ascii') === 'GIF87a' || b.subarray(0, 6).toString('ascii') === 'GIF89a',
  webp: (b) => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP',
  mp4: (b) => b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp',
  mov: (b) => b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp',
  m4a: (b) => b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp',
  webm: (b) => b.length >= 4 && b.subarray(0, 4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])),
  mp3: (b) => b.length >= 3 && (b.subarray(0, 3).toString('ascii') === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)),
  ogg: (b) => b.length >= 4 && b.toString('ascii', 0, 4) === 'OggS',
  wav: (b) => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE',
  aac: (b) => b.length >= 2 && b[0] === 0xff && (b[1] & 0xf6) === 0xf0,
};

// Vercel functions accept ≤ 4.5 MB request bodies → keep uploads under 4 MB
export const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024, files: 1 } });

// Run multer + save to Blob; resolves to the saved file info
export const handleUpload = (req, res) =>
  new Promise((resolve, reject) =>
    upload.single('file')(req, res, async (err) => {
      if (err) return reject(err);
      if (!req.file) return reject(new Error('No file'));
      try {
        const ext = String(req.file.originalname || '').split('.').pop().toLowerCase();
        if (!signatures[ext] || !signatures[ext](req.file.buffer)) {
          const error = new Error('File content does not match an allowed file type');
          error.status = 415;
          return reject(error);
        }
        resolve(await saveFile(req.file, req.user.id));
      } catch (e) { reject(e); }
    })
  );

const router = Router();
// Per-user cap (in-memory → per serverless instance; use Upstash/KV for a hard limit)
export const uploadLimiter = rateLimit({ windowMs: 60_000, limit: 20, keyGenerator: (req) => req.user.id, standardHeaders: true, legacyHeaders: false });
router.post('/', requireAuth, uploadLimiter, async (req, res) => {
  try {
    res.status(201).json(await handleUpload(req, res));
  } catch (e) {
    const status = e.code === 'LIMIT_FILE_SIZE' ? 413 : (e.status || 400);
    res.status(status).json({ error: e.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 4 MB)' : e.status === 415 ? e.message : 'Upload failed' });
  }
});
export default router;
