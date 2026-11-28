import { describe, it, expect } from 'vitest';

const API = process.env.API_URL || 'http://localhost:8080/api';
const WA = process.env.WA_URL || 'http://localhost:4010';
const tokens: Record<string, string> = {};
const RUN = 100000 + Math.floor(Math.random() * 800000);
const COURSE = 'Python Programming';        // seeded rule v1: attendance>=80, theory>=40, practical>=40
const HDR = 'name,phone,attendance,theory_marks,practical_marks';
let seq = 0;

async function login(id: string) {
  if (!tokens[id]) tokens[id] = (await (await fetch(`${API}/auth/demo-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: id }) })).json()).token;
  return tokens[id];
}
async function call(as: string | null, method: string, path: string, body?: any) {
  const headers: any = { 'content-type': 'application/json' };
  if (as) headers.authorization = 'Bearer ' + (as.length > 30 ? as : await login(as));   // long string = raw (tampered) token
  const r = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const csv = (n: number) => [HDR, ...Array.from({ length: n }, () => { const k = seq++; return `Person ${String.fromCharCode(65 + (k % 26))}${String.fromCharCode(65 + (Math.floor(k / 26) % 26))},9${RUN}${String(k).padStart(3, '0')},90,60,60`; })].join('\n');
async function newBatch(n: number, submit = true) {
  const r = await call('anika', 'POST', '/batches', { title: `Test batch ${n}`, course: COURSE, csv: csv(n) });
  expect(r.status).toBe(201);
  if (submit) expect((await call('anika', 'POST', `/batches/${r.body.id}/submit`)).status).toBe(200);
  return r.body.id as string;
}
const decide = (as: string, id: string, decision = 'APPROVE', reason?: string) => call(as, 'POST', `/batches/${id}/decision`, { decision, reason });
const detail = async (id: string) => (await call('farah', 'GET', `/batches/${id}`)).body;
async function waitFor<T>(fn: () => Promise<T | false>, ms = 100000): Promise<T> {
  const t = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 1000)); }
}
async function approveAll(id: string, big = false) {
  await decide('dev', id); await decide('meera', id);
  if (big) await decide('neha', id);
  expect((await decide('farah', id)).status).toBe(200);
}

describe('moments that must work', () => {
  it('1. bad spreadsheet rows: exact errors, nothing saved', async () => {
    const before = (await call('anika', 'GET', '/batches')).body.length;
    const r = await call('anika', 'POST', '/batches', { title: 'Bad batch', course: COURSE, csv: HDR + '\nAsha Rao,9900000000,90,60,60\n,123,90,60,60\nBob 9,9811111111,90,60,60\nAsha Again,9900000000,90,60,60\nCara Dev,9822222222,120,abc,60' });
    expect(r.status).toBe(422);
    expect(r.body.errors.map((e: any) => e.row)).toEqual(expect.arrayContaining([3, 4, 5, 6]));
    expect((await call('anika', 'GET', '/batches')).body.length).toBe(before);
  });

  it('2. two officers approve at the same moment: batch moves forward once', async () => {
    const id = await newBatch(3);
    const [a, b] = await Promise.all([decide('dev', id), decide('meera', id)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const d = await detail(id);
    expect(d.batch.status).toBe('STATE_REVIEW');
    expect(d.timeline.filter((t: any) => t.action === 'batch.advanced').length).toBe(1);
    expect([403, 409]).toContain((await decide('kabir', id)).status);          // late third approval cannot move it again
  });

  it('2b. same officer cannot approve twice', async () => {
    const id = await newBatch(3);
    expect((await decide('dev', id)).status).toBe(200);
    expect((await decide('dev', id)).status).toBe(409);
  });

  it('3. 60 candidates: every candidate gets exactly one certificate and one WhatsApp message, despite failures', async () => {
    const id = await newBatch(60);
    await decide('dev', id); await decide('meera', id);
    expect((await detail(id)).batch.status).toBe('QUALITY_REVIEW');            // big batch => quality team
    expect((await decide('farah', id)).status).toBe(403);                      // cannot skip a step
    await decide('neha', id);
    expect((await decide('farah', id)).status).toBe(200);
    const d = await waitFor(async () => { const x = await detail(id); return x.batch.status === 'ISSUED' && x; });
    expect(d.certificates.length).toBe(60);
    expect(new Set(d.certificates.map((c: any) => c.serial)).size).toBe(60);
    expect(d.certificates.every((c: any) => c.delivery_status === 'SENT')).toBe(true);
    const sent: any[] = await (await fetch(WA + '/sent')).json();
    for (const c of d.certificates) expect(sent.filter(s => s.key === c.id).length).toBe(1);
  });

  it('4. cancelled certificate is immediately invalid for verifiers and downloads', async () => {
    const id = await newBatch(3); await approveAll(id);
    const cert = (await detail(id)).certificates[0];
    const v1 = await fetch(`${API}/verify/${cert.token}`);
    expect((await v1.json()).status).toBe('VALID');
    expect((await call('farah', 'POST', `/certificates/${cert.id}/cancel`, { reason: 'Issued by mistake' })).status).toBe(200);
    expect((await (await fetch(`${API}/verify/${cert.token}`)).json()).status).toBe('CANCELLED');
    expect((await fetch(`${API}/c/${cert.token}/pdf`)).status).toBe(410);
  });

  it('5. a stuck batch is escalated to the state office without anyone chasing', async () => {
    const id = await newBatch(3);
    await call('farah', 'POST', `/test/age/${id}`);
    expect((await call('farah', 'GET', '/stuck')).body.map((b: any) => b.id)).toContain(id);
    expect((await detail(id)).timeline.some((t: any) => t.action === 'batch.escalated')).toBe(true);
  });

  it('6. return -> fix -> resubmit: earlier approvals are voided, review restarts', async () => {
    const id = await newBatch(3);
    await decide('dev', id);
    expect((await decide('meera', id, 'RETURN', 'Phone numbers look wrong')).status).toBe(200);
    expect((await detail(id)).batch.status).toBe('RETURNED');
    expect((await call('anika', 'PUT', `/batches/${id}/candidates`, { csv: csv(3) })).status).toBe(200);
    expect((await call('anika', 'POST', `/batches/${id}/submit`)).status).toBe(200);
    await decide('dev', id);
    const d = await detail(id);
    expect(d.batch.status).toBe('DISTRICT_REVIEW');                            // Dev's round-1 approval does not count
    expect(d.batch.round).toBe(2);
    expect(d.approvals.length).toBe(1);
    await decide('meera', id);
    expect((await detail(id)).batch.status).toBe('STATE_REVIEW');
  });
});

describe('eligibility and versioned rules', () => {
  const rawBatch = async (course: string, rows: string[]) => {
    const r = await call('anika', 'POST', '/batches', { title: 'Rule test', course, csv: [HDR, ...rows].join('\n') });
    expect(r.status).toBe(201);
    await call('anika', 'POST', `/batches/${r.body.id}/submit`);
    return r.body.id as string;
  };
  const ph = () => `9${RUN}${String(seq++).padStart(3, '0')}`;

  it('2. raising a pass mark: old batch keeps its rule version, new batch uses the new one', async () => {
    const course = `Rule course ${RUN}`;
    const set = (a: number) => call('farah', 'POST', '/courses/rules', { course, minAttendance: a, minTheory: 40, minPractical: 40 });
    const v1 = (await set(80)).body.version;
    const oldId = await rawBatch(course, [`Mona Rao,${ph()},90,60,60`]);
    const v2 = (await set(95)).body.version;
    const newId = await rawBatch(course, [`Mona Rao,${ph()},90,60,60`]);
    const [o, n] = [await detail(oldId), await detail(newId)];
    expect(v2).toBe(v1 + 1);
    expect(o.rule.version).toBe(v1); expect(o.candidates[0].eligible).toBe(true);
    expect(n.rule.version).toBe(v2); expect(n.candidates[0].eligible).toBe(false);
    expect((await call('dev', 'POST', '/courses/rules', { course, minAttendance: 1, minTheory: 1, minPractical: 1 })).status).toBe(403);
  });

  it('ineligible candidate gets no certificate without an override + reason', async () => {
    const id = await rawBatch(COURSE, [`Good One,${ph()},90,60,60`, `Low Attend,${ph()},50,60,60`]);
    await approveAll(id);
    expect((await detail(id)).certificates.length).toBe(1);
    const id2 = await rawBatch(COURSE, [`Good Two,${ph()},90,60,60`, `Low Attend,${ph()},50,60,60`]);
    const bad = (await detail(id2)).candidates.find((c: any) => !c.eligible);
    expect((await call('dev', 'POST', `/candidates/${bad.id}/override`, { reason: 'Medical leave' })).status).toBe(403);
    expect((await call('farah', 'POST', `/candidates/${bad.id}/override`, { reason: 'Medical leave, approved' })).status).toBe(200);
    await approveAll(id2);
    expect((await detail(id2)).certificates.length).toBe(2);
    expect((await detail(id2)).timeline.some((t: any) => t.action === 'candidate.override')).toBe(true);
  });
});

describe('things that must never happen', () => {
  it('rejects unauthenticated and tampered tokens', async () => {
    expect((await call(null, 'GET', '/batches')).status).toBe(401);
    const t = await login('anika');
    expect((await call(t.slice(0, -3) + 'abc', 'GET', '/batches')).status).toBe(401);
  });
  it('wrong role / wrong step cannot act', async () => {
    const id = await newBatch(3);
    expect((await decide('anika', id)).status).toBe(403);
    expect((await decide('neha', id)).status).toBe(403);
    expect((await decide('farah', id)).status).toBe(403);
    expect((await call('dev', 'POST', '/certificates/00000000-0000-4000-8000-000000000000/cancel', { reason: 'nope' })).status).toBe(403);
  });
  it("another centre cannot see or edit someone else's batch", async () => {
    const id = await newBatch(3, false);
    expect((await call('ravi', 'GET', `/batches/${id}`)).status).toBe(404);
    expect((await call('ravi', 'POST', `/batches/${id}/submit`)).status).toBe(404);
    expect((await call('ravi', 'GET', '/batches')).body.some((b: any) => b.id === id)).toBe(false);
  });
  it('public verification leaks no personal data and cannot be enumerated', async () => {
    const id = await newBatch(3); await approveAll(id);
    const cert = (await detail(id)).certificates[0];
    const text = JSON.stringify(await (await fetch(`${API}/verify/${cert.token}`)).json());
    expect(text).not.toMatch(/\+?91\d{10}|9\d{9}/);
    expect(text).not.toContain(cert.name);                                     // only a masked name
    expect((await fetch(`${API}/verify/${'0'.repeat(64)}`)).status).toBe(404);
    expect((await fetch(`${API}/verify/${cert.serial}`)).status).toBe(404);    // serial is not a lookup key
    expect((await fetch(`${API}/c/${'f'.repeat(64)}/pdf`)).status).toBe(404);
  });
});
