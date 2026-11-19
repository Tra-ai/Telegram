// Bot API — Telegram-style:  GET|POST /api/bot/<TOKEN>/<method>   (params as JSON body or query string)
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { prisma } from '../db.js';
import { createMessage } from '../services/messages.js';
import { botFromToken, callBotMethod, BotApiError } from '../services/bots.js';

const router = Router();
const handler429 = (_req, res) => res.status(429).json({ ok: false, error_code: 429, description: 'Too many requests' });
// 1) Before authentication: per client IP only. (Keying on the token's bot-id prefix let anyone who knew a
//    bot's public user id burn its quota with bogus tokens and lock the real bot out.)
const ipLimiter = rateLimit({ windowMs: 10_000, limit: 300, standardHeaders: true, legacyHeaders: false, handler: handler429 });
// 2) After authentication: per bot (100 requests / 10 s), so only the real token holder can use it up.
const botLimiter = rateLimit({
  windowMs: 10_000, limit: 100, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => req.bot.id, handler: handler429,
});

async function authBot(req, res, next) {
  const bot = await botFromToken(prisma, req.params.token);
  if (!bot) return res.status(401).json({ ok: false, error_code: 401, description: 'Unauthorized' });
  req.bot = bot;
  next();
}

router.all('/:token/:method', ipLimiter, authBot, botLimiter, async (req, res) => {
  try {
    const bot = req.bot;
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
