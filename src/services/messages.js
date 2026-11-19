import { prisma } from '../db.js';
import { isBlobUrl } from '../storage.js';
import { queueBotUpdates } from './bots.js';

export const userSelect = { id: true, username: true, displayName: true, avatarUrl: true };
export const messageInclude = {
  sender: { select: userSelect },
  replyTo: { select: { id: true, text: true, type: true, deletedAt: true, sender: { select: userSelect } } },
};
const TYPES = ['TEXT', 'IMAGE', 'VIDEO', 'VOICE', 'FILE'];

// Deleted messages are sent as tombstones so polling clients can remove them
export const shapeMessage = (m) =>
  m.deletedAt ? { id: m.id, chatId: m.chatId, deleted: true, createdAt: m.createdAt, updatedAt: m.updatedAt } : m;

export async function createMessage(userId, data) {
  const { chatId, text, fileUrl, fileName, fileSize, duration, replyToId } = data || {};
  const type = TYPES.includes(data?.type) ? data.type : 'TEXT';
  if (!chatId || typeof chatId !== 'string') throw new Error('chatId required');

  const member = await prisma.member.findUnique({ where: { chatId_userId: { chatId, userId } }, include: { chat: true } });
  if (!member) throw new Error('Not a member of this chat');

  // Private chats: no messages in either direction once one side has blocked the other
  if (member.chat.type === 'PRIVATE' && member.chat.privateKey) {
    const peer = member.chat.privateKey.split(':').find((id) => id !== userId); // undefined = Saved Messages
    if (peer) {
      const b = await prisma.block.findFirst({
        where: { OR: [{ blockerId: userId, blockedId: peer }, { blockerId: peer, blockedId: userId }] },
      });
      if (b) throw new Error(b.blockerId === userId ? 'You blocked this user' : "You can't message this user");
    }
  }

  const clean = typeof text === 'string' ? text.trim().slice(0, 4000) : '';
  if (type === 'TEXT' && !clean) throw new Error('Empty message');
  if (type !== 'TEXT' && !isBlobUrl(fileUrl, userId)) throw new Error('Invalid file');
  if (replyToId) {
    const target = await prisma.message.findFirst({ where: { id: String(replyToId), chatId, deletedAt: null } });
    if (!target) throw new Error('Reply target not found');
  }

  const msg = await prisma.message.create({
    data: {
      chatId, senderId: userId, type,
      text: clean || null,
      fileUrl: type === 'TEXT' ? null : fileUrl,
      fileName: type === 'TEXT' ? null : String(fileName || '').slice(0, 200) || null,
      fileSize: Number.isInteger(fileSize) ? fileSize : null,
      duration: Number.isInteger(duration) ? duration : null,
      replyToId: replyToId ? String(replyToId) : null,
    },
    include: messageInclude,
  });
  await prisma.member.update({
    where: { chatId_userId: { chatId, userId } },
    data: { lastReadAt: msg.createdAt, typingAt: null },
  });
  // Bots in this chat get the message in their getUpdates queue (never allowed to break sending)
  await queueBotUpdates(prisma, msg).catch((e) => console.error('queueBotUpdates', e));
  return msg;
}

export async function markRead(userId, chatId) {
  const readAt = new Date();
  const r = await prisma.member.updateMany({ where: { chatId: String(chatId), userId }, data: { lastReadAt: readAt } });
  if (!r.count) throw new Error('Not a member of this chat');
  return readAt;
}
