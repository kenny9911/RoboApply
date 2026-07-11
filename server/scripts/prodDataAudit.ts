import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env') });
(async () => {
  const { prisma } = await import('../src/lib/prisma.js');
  const p = prisma as any;
  // 1. RAJob inventory by sourceBoard + archived state
  const boards = await p.rAJob.groupBy({ by: ['sourceBoard'], _count: { _all: true } });
  const archived = await p.rAJob.groupBy({ by: ['sourceBoard'], where: { archivedAt: { not: null } }, _count: { _all: true } });
  console.log('RAJOB BY BOARD:', JSON.stringify(boards.map((b: any) => ({ b: b.sourceBoard, n: b._count._all }))));
  console.log('  archived:', JSON.stringify(archived.map((b: any) => ({ b: b.sourceBoard, n: b._count._all }))));
  // 2. Seed rows: active (user-visible in /search) count + a sample
  const seedActive = await p.rAJob.count({ where: { sourceBoard: 'seed', archivedAt: null } });
  const seedSample = await p.rAJob.findMany({ where: { sourceBoard: 'seed' }, take: 3, select: { title: true, companyName: true, applyUrl: true } });
  console.log(`SEED ACTIVE (visible in /search): ${seedActive}`);
  for (const s of seedSample) console.log(`  seed sample: "${s.title}" @ ${s.companyName} applyUrl=${s.applyUrl?.slice(0, 40)}`);
  // 3. Fixture/test users
  const fixtures = await p.user.findMany({
    where: { OR: [
      { email: { contains: 'claude-ui-check' } }, { email: { contains: 'example.com' } },
      { email: { contains: 'test' } }, { email: { contains: 'demo' } },
    ] },
    select: { email: true, role: true, createdAt: true }, take: 20,
  });
  console.log('FIXTURE-LIKE USERS:', fixtures.length);
  for (const u of fixtures) console.log(`  ${u.email} (${u.role})`);
  // 4. Users + real content volumes (launch sanity)
  const [users, variants, tracker, scores] = await Promise.all([
    p.user.count(), p.rAResumeVariant.count(), p.rATrackerEntry.count(), p.rAJobMatchScore.count(),
  ]);
  console.log(`VOLUMES users=${users} variants=${variants} tracker=${tracker} scores=${scores}`);
  process.exit(0);
})().catch((e) => { console.error('AUDIT FAILED', e?.message); process.exit(1); });
