import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../auth.js';
import { saveFile } from '../storage.js';

// Vercel functions accept ≤ 4.5 MB request bodies → keep uploads under 4 MB
export const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024, files: 1 } });

// Run multer + save to Blob; resolves to the saved file info
export const handleUpload = (req, res) =>
  new Promise((resolve, reject) =>
    upload.single('file')(req, res, async (err) => {
      if (err) return reject(err);
      if (!req.file) return reject(new Error('No file'));
      try { resolve(await saveFile(req.file, req.user.id)); } catch (e) { reject(e); }
    })
  );

const router = Router();
// Per-user cap (in-memory → per serverless instance; use Upstash/KV for a hard limit)
export const uploadLimiter = rateLimit({ windowMs: 60_000, limit: 20, keyGenerator: (req) => req.user.id, standardHeaders: true, legacyHeaders: false });
router.post('/', requireAuth, uploadLimiter, async (req, res) => {
  try {
    res.status(201).json(await handleUpload(req, res));
  } catch (e) {
    res.status(400).json({ error: e.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 4 MB)' : e.message });
  }
});
export default router;
