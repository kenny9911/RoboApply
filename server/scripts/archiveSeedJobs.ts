import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env') });
(async () => {
  const { prisma } = await import('../src/lib/prisma.js');
  const p = prisma as any;
  const before = await p.rAJob.count({ where: { sourceBoard: 'seed', archivedAt: null } });
  const res = await p.rAJob.updateMany({
    where: { sourceBoard: 'seed', archivedAt: null },
    data: { archivedAt: new Date() },
  });
  const visibleAfter = await p.rAJob.count({ where: { archivedAt: null } });
  const byBoard = await p.rAJob.groupBy({ by: ['sourceBoard'], where: { archivedAt: null }, _count: { _all: true } });
  console.log(`ARCHIVED ${res.count}/${before} seed rows.`);
  console.log(`VISIBLE inventory now: ${visibleAfter} → ${JSON.stringify(byBoard.map((b: any) => ({ b: b.sourceBoard, n: b._count._all })))}`);
  process.exit(0);
})().catch((e) => { console.error('FAILED', e?.message); process.exit(1); });
