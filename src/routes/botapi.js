// Bot API — Telegram-style:  GET|POST /api/bot/<TOKEN>/<method>   (params as JSON body or query string)
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { prisma } from '../db.js';
import { createMessage } from '../services/messages.js';
import { botFromToken, callBotMethod, BotApiError } from '../services/bots.js';

const router = Router();
const limiter = rateLimit({
  windowMs: 10_000, limit: 100, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => String(req.params.token || '').split(':')[0] || 'anon',
  handler: (_req, res) => res.status(429).json({ ok: false, error_code: 429, description: 'Too many requests' }),
});

router.all('/:token/:method', limiter, async (req, res) => {
  try {
    const bot = await botFromToken(prisma, req.params.token);
    if (!bot) return res.status(401).json({ ok: false, error_code: 401, description: 'Unauthorized' });
    // A bot that keeps calling the API shows as "online"
    if (Date.now() - bot.user.lastSeen.getTime() > 20_000) prisma.user.update({ where: { id: bot.userId }, data: { lastSeen: new Date() } }).catch(() => {});
    const params = { ...req.query, ...(req.body && typeof req.body === 'object' ? req.body : {}) };
    const result = await callBotMethod({ db: prisma, bot, method: req.params.method, params, createMessage });
    res.json({ ok: true, result });
  } catch (e) {
    if (e instanceof BotApiError) return res.status(e.code).json({ ok: false, error_code: e.code, description: e.message });
    console.error(e);
    res.status(500).json({ ok: false, error_code: 500, description: 'Server error' });
  }
});

export default router;
