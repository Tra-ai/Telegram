// Bot logic. Takes the Prisma client (`db`) as a parameter so it can be tested without a database.
import crypto from 'crypto';

// Telegram rule: bot usernames end in "bot". Regular signups with such names are refused (see routes/auth.js).
export const BOT_USERNAME = /^[a-z][a-z0-9_]{2,28}bot$/;
export const endsWithBot = (u) => /bot$/i.test(String(u || ''));

export class BotApiError extends Error {
  constructor(code, description) { super(description); this.code = code; }
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Token = "<botUserId>:<random secret>". Only the hash of the secret is stored.
export function newToken(userId) {
  const secret = crypto.randomBytes(24).toString('base64url');
  return { token: `${userId}:${secret}`, hash: sha(secret) };
}

export async function botFromToken(db, token) {
  const t = String(token || '');
  const i = t.indexOf(':');
  if (i < 1 || t.length > 200) return null;
  const secret = t.slice(i + 1);
  if (!secret) return null;
  const bot = await db.bot.findUnique({ where: { userId: t.slice(0, i) }, include: { user: true } });
  if (!bot || bot.user.isBanned) return null;
  const a = Buffer.from(sha(secret)), b = Buffer.from(bot.tokenHash);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? bot : null;
}

// Called after every new message: every OTHER bot that is a member of the chat gets an update.
export async function queueBotUpdates(db, msg) {
  const bots = await db.bot.findMany({
    where: { userId: { not: msg.senderId }, user: { memberships: { some: { chatId: msg.chatId } } } },
    select: { id: true },
  });
  if (bots.length) await db.botUpdate.createMany({ data: bots.map((b) => ({ botId: b.id, messageId: msg.id })) });
}

// ---------- Bot API (Telegram-style methods) ----------
const U = { id: true, username: true, displayName: true, avatarUrl: true };
const MSG_INCLUDE = {
  sender: { select: U },
  replyTo: { select: { id: true, text: true, type: true, deletedAt: true, sender: { select: U } } },
  chat: { select: { id: true, type: true, title: true } },
};
const from = (u) => ({ id: u.id, is_bot: endsWithBot(u.username), first_name: u.displayName, username: u.username });
const int = (v, d = null) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const str = (v) => (v == null ? '' : String(v));

export function shapeMessage(m, botUserId) {
  const chat = m.chat.type === 'PRIVATE'
    ? { id: m.chat.id, type: 'private', ...(m.senderId !== botUserId ? { first_name: m.sender.displayName, username: m.sender.username } : {}) }
    : { id: m.chat.id, type: 'group', title: m.chat.title };
  const out = { message_id: m.id, date: Math.floor(new Date(m.createdAt).getTime() / 1000), chat, from: from(m.sender), type: String(m.type).toLowerCase() };
  if (m.text) out.text = m.text;
  if (m.fileUrl) { out.file_url = m.fileUrl; out.file_name = m.fileName; out.file_size = m.fileSize; }
  if (m.duration != null) out.duration = m.duration;
  if (m.editedAt) out.edit_date = Math.floor(new Date(m.editedAt).getTime() / 1000);
  if (m.replyTo && !m.replyTo.deletedAt) out.reply_to_message = { message_id: m.replyTo.id, text: m.replyTo.text || undefined, from: from(m.replyTo.sender) };
  return out;
}

const COMMAND = /^[a-z0-9_]{1,32}$/;
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

export async function callBotMethod({ db, bot, method, params = {}, createMessage, sleep = sleepMs }) {
  const p = params || {};
  const loadShaped = async (id) => {
    const m = await db.message.findFirst({ where: { id, deletedAt: null }, include: MSG_INCLUDE });
    return m ? shapeMessage(m, bot.userId) : null;
  };
  const ownMessage = async () => {
    const chatId = str(p.chat_id), id = str(p.message_id);
    if (!chatId || !id) throw new BotApiError(400, 'chat_id and message_id are required');
    const m = await db.message.findFirst({ where: { id, chatId, deletedAt: null } });
    if (!m) throw new BotApiError(404, 'Message not found');
    if (m.senderId !== bot.userId) throw new BotApiError(403, 'A bot can only change its own messages');
    return m;
  };

  switch (method) {
    case 'getMe':
      return { id: bot.userId, is_bot: true, first_name: bot.user.displayName, username: bot.user.username, description: bot.description };

    case 'getUpdates': {
      const offset = int(p.offset);
      const limit = clamp(int(p.limit, 100), 1, 100);
      const timeout = clamp(int(p.timeout, 0), 0, 8); // Vercel functions live ≤ 10s
      const stale = new Date(Date.now() - 24 * 3600 * 1000); // like Telegram: updates are kept 24h
      await db.botUpdate.deleteMany({ where: { botId: bot.id, OR: [...(offset != null ? [{ id: { lt: offset } }] : []), { createdAt: { lt: stale } }] } });
      const q = { where: { botId: bot.id, ...(offset != null ? { id: { gte: offset } } : {}) }, orderBy: { id: 'asc' }, take: limit };
      let rows = await db.botUpdate.findMany(q);
      const end = Date.now() + timeout * 1000;
      while (!rows.length && Date.now() < end) { await sleep(1000); rows = await db.botUpdate.findMany(q); }
      if (!rows.length) return [];
      const msgs = await db.message.findMany({ where: { id: { in: rows.map((r) => r.messageId) }, deletedAt: null }, include: MSG_INCLUDE });
      const byId = new Map(msgs.map((m) => [m.id, m]));
      return rows.filter((r) => byId.has(r.messageId)).map((r) => ({ update_id: r.id, message: shapeMessage(byId.get(r.messageId), bot.userId) }));
    }

    case 'sendMessage': {
      try {
        const m = await createMessage(bot.userId, { chatId: str(p.chat_id), text: p.text, replyToId: p.reply_to_message_id ? str(p.reply_to_message_id) : undefined });
        return await loadShaped(m.id);
      } catch (e) {
        throw new BotApiError(e.message === 'Not a member of this chat' ? 403 : 400, e.message);
      }
    }

    case 'editMessageText': {
      const m = await ownMessage();
      const text = str(p.text).trim().slice(0, 4000);
      if (m.type === 'TEXT' && !text) throw new BotApiError(400, 'Empty message');
      await db.message.update({ where: { id: m.id }, data: { text: text || null, editedAt: new Date() } });
      return await loadShaped(m.id);
    }

    case 'deleteMessage': {
      const m = await ownMessage();
      await db.message.update({ where: { id: m.id }, data: { deletedAt: new Date(), text: null, fileUrl: null, fileName: null } });
      return true;
    }

    case 'sendChatAction': {
      const r = await db.member.updateMany({ where: { chatId: str(p.chat_id), userId: bot.userId }, data: { typingAt: new Date() } });
      if (!r.count) throw new BotApiError(403, 'Not a member of this chat');
      return true;
    }

    case 'setMyCommands': {
      const list = Array.isArray(p.commands) ? p.commands : null;
      if (!list || list.length > 50) throw new BotApiError(400, 'commands: array of up to 50 {command, description}');
      const commands = list.map((c) => ({ command: str(c && c.command).replace(/^\//, '').toLowerCase(), description: str(c && c.description).slice(0, 256) }));
      if (commands.some((c) => !COMMAND.test(c.command) || !c.description)) throw new BotApiError(400, 'Each command needs a name (a-z 0-9 _) and a description');
      await db.bot.update({ where: { id: bot.id }, data: { commands } });
      return true;
    }

    case 'getMyCommands':
      return Array.isArray(bot.commands) ? bot.commands : [];

    default:
      throw new BotApiError(404, 'Method not found: ' + method);
  }
}
