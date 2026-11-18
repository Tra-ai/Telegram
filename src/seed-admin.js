import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { prisma } from './db.js';

const username = (process.env.ADMIN_USERNAME || 'admin').toLowerCase();
const password = process.env.ADMIN_PASSWORD;
if (!password || password.length < 8) {
  console.error('Set ADMIN_PASSWORD (8+ chars) in .env first');
  process.exit(1);
}
const passwordHash = await bcrypt.hash(password, 10);
await prisma.user.upsert({
  where: { username },
  update: { passwordHash, role: 'ADMIN', isBanned: false },
  create: { username, displayName: 'Admin', passwordHash, role: 'ADMIN' },
});
console.log(`Admin ready: ${username}`);
await prisma.$disconnect();
