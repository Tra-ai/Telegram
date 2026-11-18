import { prisma } from '../db.js';
import { removeFileIfUnused } from '../storage.js';

// Leave a group safely:
//  - last member leaving → the (now empty) group and its files are deleted
//  - owner leaving → ownership passes to the oldest admin, else the oldest member (who becomes admin)
export async function leaveGroup(chatId, userId) {
  const chat = await prisma.chat.findUnique({ where: { id: chatId } });
  if (!chat || chat.type !== 'GROUP') return;
  const cleanup = [];
  const remaining = await prisma.member.findMany({ where: { chatId, NOT: { userId } }, orderBy: { joinedAt: 'asc' } });

  if (!remaining.length) {
    const files = await prisma.message.findMany({ where: { chatId, fileUrl: { not: null } }, select: { fileUrl: true } });
    cleanup.push(...files.map((f) => f.fileUrl), chat.avatarUrl);
    await prisma.chat.delete({ where: { id: chatId } });
  } else {
    const ops = [prisma.member.deleteMany({ where: { chatId, userId } })];
    if (chat.ownerId === userId) {
      const next = remaining.find((m) => m.isAdmin) || remaining[0];
      ops.push(prisma.chat.update({ where: { id: chatId }, data: { ownerId: next.userId } }));
      if (!next.isAdmin) ops.push(prisma.member.update({ where: { id: next.id }, data: { isAdmin: true } }));
    }
    await prisma.$transaction(ops);
  }
  await Promise.all([...new Set(cleanup.filter(Boolean))].map(removeFileIfUnused));
}
