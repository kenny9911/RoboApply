// lib/api/resumes.ts uploadResume (INT-10): the multipart body carries the
// file, its idempotency key and, only when asked, `localParser=1` (read the
// file on our own servers, no outside parsing service).

import { beforeEach, describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../lib/api/client', async (orig) => ({ ...(await orig<Record<string, unknown>>()), request: client.request }));

import { RESUME_UPLOADS_PER_DAY, uploadResume } from '../../lib/api/resumes';

const file = () => new File(['%PDF-1.4 resume'], 'cv.pdf', { type: 'application/pdf' });

beforeEach(() => {
  client.request.mockReset();
  client.request.mockResolvedValue({ resume: { id: 'rv_1', name: 'cv' } });
});

describe('uploadResume', () => {
  it('posts the file with an idempotency key and no local-parser flag by default', async () => {
    const resume = await uploadResume(file(), { name: 'My resume' });
    expect(resume).toEqual({ id: 'rv_1', name: 'cv' });
    const [method, path, opts] = client.request.mock.calls[0]!;
    expect(method).toBe('POST');
    expect(path).toBe('/api/v1/roboapply/v2/resumes/upload');
    expect(opts.multipart).toBe(true);
    const fd = opts.body as FormData;
    expect((fd.get('file') as File).name).toBe('cv.pdf');
    expect(fd.get('name')).toBe('My resume');
    expect(String(fd.get('idempotencyKey')).length).toBeGreaterThan(8);
    expect(fd.has('localParser')).toBe(false);
  });

  it('localParser: true adds localParser=1', async () => {
    await uploadResume(file(), { localParser: true });
    const fd = client.request.mock.calls[0]![2].body as FormData;
    expect(fd.get('localParser')).toBe('1');
  });

  it('the same file gives the same idempotency key (a retry replays the first upload)', async () => {
    await uploadResume(file());
    await uploadResume(file());
    const keys = client.request.mock.calls.map((c) => (c[2].body as FormData).get('idempotencyKey'));
    expect(keys[0]).toBe(keys[1]);
  });

  it('mirrors the server\'s daily cap', () => {
    expect(RESUME_UPLOADS_PER_DAY).toBe(10);
  });
});
