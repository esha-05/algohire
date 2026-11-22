// Run from the project folder while the stack is up:  node scenarios.mjs
// Needs Node 18+ (built-in fetch). Talks to the same URLs the UI uses.
const API = 'http://localhost:8080/api';
const MOCK = 'http://localhost:4010';
const RUN = String(Date.now()).slice(-6); // keeps phones/titles unique per run

let pass = 0, fail = 0;
const ok = (c, msg, extra = '') => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + msg + (c || !extra ? '' : '  -> ' + extra)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function login(id) {
  const r = await fetch(API + '/auth/demo-login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: id }) });
  const j = await r.json();
  return { id, token: j.token, user: j.user };
}
async function call(u, path, method = 'GET', body) {
  const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(u?.token ? { authorization: 'Bearer ' + u.token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

// ADJUST THIS if your validator wants a different phone format (check frontend/public/sample.csv).
const phone = i => '+9199' + RUN + String(i).padStart(2, '0');
const csv = (n, tag = 'Cand') => 'name,phone\n' + Array.from({ length: n }, (_, i) => `${tag} ${i + 1},${phone(i + 1)}`).join('\n');

async function newBatch(anika, n, label) {
  const r = await call(anika, '/batches', 'POST', { title: `${label} ${RUN}`, course: 'Retail Sales', csv: csv(n, label.replace(/\W/g, '')) });
  if (!r.json.id) throw new Error('Could not create batch: ' + JSON.stringify(r.json));
  return r.json.id;
}
const detail = (u, id) => call(u, '/batches/' + id).then(r => r.json);
const decide = (u, id, decision = 'APPROVE', reason) => call(u, `/batches/${id}/decision`, 'POST', { decision, reason });
async function waitStatus(u, id, want, secs = 150) {
  for (let i = 0; i < secs; i++) {
    const d = await detail(u, id);
    if (d.batch?.status === want) return d;
    await sleep(1000);
  }
  return detail(u, id);
}

const U = {};
for (const id of ['anika', 'ravi', 'dev', 'kabir', 'meera', 'neha', 'farah']) U[id] = await login(id).catch(() => ({}));
// If a demo id differs (e.g. "ravi"), check GET /api/demo-users and edit the list above.

console.log('\n--- Scenario 1: invalid CSV is rejected as a whole ---');
{
  const title = `Bad ${RUN}`;
  const bad = 'name,phone\nAsha,' + phone(1) + '\n,' + phone(2) + '\nBilal,12345\nChitra,' + phone(4) + '\nDev,' + phone(4) + '\nEesha,' + phone(6) + '\nFarid,abc';
  const r = await call(U.anika, '/batches', 'POST', { title, course: 'Retail Sales', csv: bad });
  ok(r.status >= 400 && r.status < 500, 'bad CSV returns a 4xx', r.status);
  ok(Array.isArray(r.json.errors) && r.json.errors.length >= 3, 'row errors are listed', JSON.stringify(r.json));
  ok(r.json.errors?.every(e => Number.isInteger(e.row) && e.message), 'every error has a row number and message');
  const list = await call(U.anika, '/batches');
  ok(!list.json.some(b => b.title === title), 'no half-saved batch exists');
}

console.log('\n--- Scenario 2: simultaneous district approvals advance once (5 races) ---');
for (let i = 0; i < 5; i++) {
  const id = await newBatch(U.anika, 5, 'Race' + i);
  await call(U.anika, `/batches/${id}/submit`, 'POST');
  const [a, b] = await Promise.all([decide(U.dev, id), decide(U.meera, id)]);
  const d = await detail(U.anika, id);
  ok(['STATE_REVIEW'].includes(d.batch.status), `race ${i + 1}: batch is STATE_REVIEW exactly once`, `${d.batch.status} (${a.status}/${b.status})`);
  ok(d.approvals.length === 2, `race ${i + 1}: both approvals recorded`, d.approvals.length);
  const again = await decide(U.dev, id);
  ok(again.status >= 400, `race ${i + 1}: same officer cannot approve again`, again.status);
  const farah = await decide(U.farah, id);
  const issued = await waitStatus(U.anika, id, 'ISSUED', 60);
  ok(issued.certificates.length === 5, `race ${i + 1}: exactly 5 certificates after state approval`, issued.certificates.length);
  if (i === 0) globalThis.firstIssued = issued; // reused for cancellation test
}

console.log('\n--- Scenario 3: 60 candidates, quality review, one message each ---');
let bigId;
{
  bigId = await newBatch(U.anika, 60, 'Big');
  await call(U.anika, `/batches/${bigId}/submit`, 'POST');
  await decide(U.dev, bigId); await decide(U.meera, bigId);
  let d = await detail(U.anika, bigId);
  ok(d.batch.status === 'QUALITY_REVIEW', 'after 2 district approvals a 60-batch goes to QUALITY_REVIEW', d.batch.status);
  const skip = await decide(U.farah, bigId);
  ok(skip.status >= 400, 'state office cannot skip the quality step', skip.status);
  const wrong = await decide(U.dev, bigId);
  ok(wrong.status >= 400, 'district officer cannot act at the quality step', wrong.status);
  await decide(U.neha, bigId);
  d = await detail(U.anika, bigId);
  ok(d.batch.status === 'STATE_REVIEW', 'after Neha the batch is STATE_REVIEW', d.batch.status);
  await decide(U.farah, bigId);
  console.log('     waiting for WhatsApp delivery with retries (up to 150s)...');
  d = await waitStatus(U.anika, bigId, 'ISSUED', 150);
  ok(d.batch.status === 'ISSUED', 'batch reaches ISSUED', d.batch.status);
  ok(d.certificates.length === 60, '60 certificates created', d.certificates.length);
  ok(new Set(d.certificates.map(c => c.serial)).size === 60, 'all 60 serial numbers are unique');
  ok(d.certificates.every(c => c.delivery_status === 'SENT'), 'every certificate is SENT');
  console.log('     total delivery attempts:', d.certificates.reduce((s, c) => s + (c.delivery_attempts || 0), 0), '(more than 60 means retries happened)');
  const sent = await fetch(MOCK + '/sent').then(r => r.json()).then(a => a.map(x => JSON.stringify(x)));
  let dup = 0, miss = 0;
  for (let i = 1; i <= 60; i++) {
    const n = sent.filter(s => s.includes(phone(i).replace('+', ''))).length;
    if (n === 0) miss++; if (n > 1) dup++;
  }
  ok(miss === 0 && dup === 0, 'mock WhatsApp received exactly one message per candidate', `missing=${miss} duplicated=${dup}`);
}

console.log('\n--- Scenario 4: cancellation shows publicly at once ---');
{
  const c = globalThis.firstIssued.certificates[0];
  const before = await call(null, '/verify/' + c.token);
  ok(before.json.status === 'VALID', 'certificate verifies as VALID before cancel', before.json.status);
  ok(!JSON.stringify(before.json).includes(phone(1).slice(-6)), 'public page does not leak the phone number');
  const noReason = await call(U.farah, `/certificates/${c.id}/cancel`, 'POST', {});
  ok(noReason.status >= 400, 'cancel without a reason is refused', noReason.status);
  const byDist = await call(U.dev, `/certificates/${c.id}/cancel`, 'POST', { reason: 'test' });
  ok(byDist.status >= 400, 'district officer cannot cancel', byDist.status);
  const byCentre = await call(U.anika, `/certificates/${c.id}/cancel`, 'POST', { reason: 'test' });
  ok(byCentre.status >= 400, 'centre cannot cancel', byCentre.status);
  const done = await call(U.farah, `/certificates/${c.id}/cancel`, 'POST', { reason: 'Fake certificate reported by employer' });
  ok(done.status < 300, 'state office can cancel', done.status);
  const after = await call(null, '/verify/' + c.token);
  ok(after.json.status === 'CANCELLED', 'next public check says CANCELLED', after.json.status);
  const again = await call(U.farah, `/certificates/${c.id}/cancel`, 'POST', { reason: 'again' });
  ok(again.status >= 400 || (await call(null, '/verify/' + c.token)).json.status === 'CANCELLED', 'cancelled stays cancelled');
  const pdf = await fetch(API + `/c/${c.token}/pdf`);
  ok(pdf.status >= 400, 'cancelled certificate PDF is no longer downloadable', pdf.status);
}

console.log('\n--- Scenario 6: send back, fix, resubmit ---');
{
  const id = await newBatch(U.anika, 4, 'Return');
  await call(U.anika, `/batches/${id}/submit`, 'POST');
  await decide(U.dev, id);
  const noReason = await decide(U.meera, id, 'RETURN');
  ok(noReason.status >= 400, 'send back without a reason is refused', noReason.status);
  const r = await decide(U.meera, id, 'RETURN', 'Phone number of candidate 2 looks wrong');
  ok(r.status < 300, 'officer can send back with a reason', r.status);
  let d = await detail(U.anika, id);
  ok(d.batch.status === 'RETURNED' && d.batch.return_reason, 'batch is RETURNED and shows the reason', d.batch.status);
  const fix = await call(U.anika, `/batches/${id}/candidates`, 'PUT', { csv: csv(4, 'Fixed') });
  ok(fix.status < 300, 'centre can replace the candidates', fix.status);
  const other = await call(U.ravi, `/batches/${id}/submit`, 'POST');
  ok(other.status >= 400, 'a different centre cannot resubmit it', other.status);
  await call(U.anika, `/batches/${id}/submit`, 'POST');
  d = await detail(U.anika, id);
  ok(d.batch.status === 'DISTRICT_REVIEW' && d.batch.round === 2, 'resubmitted into round 2 at DISTRICT_REVIEW', `${d.batch.status} round ${d.batch.round}`);
  console.log(`     POLICY CHECK: approvals counted after resubmit = ${d.batch.approvals ?? d.approvals?.filter(a => a.round === d.batch.round).length}. Dev approved in round 1.`);
  console.log('     Write the rule you chose (kept or voided) in the README.');
}

console.log('\n--- Security: nobody acts at a step that is not theirs ---');
{
  const id = await newBatch(U.anika, 3, 'Sec');
  const early = await decide(U.dev, id);
  ok(early.status >= 400, 'officer cannot approve a DRAFT', early.status);
  await call(U.anika, `/batches/${id}/submit`, 'POST');
  const own = await decide(U.anika, id);
  ok(own.status >= 400, 'centre cannot approve its own batch', own.status);
  const st = await decide(U.farah, id);
  ok(st.status >= 400, 'state office cannot act at district step', st.status);
  const q = await decide(U.neha, id);
  ok(q.status >= 400, 'quality team cannot act at district step', q.status);
  const spoof = await call(U.anika, `/batches/${id}/decision`, 'POST', { decision: 'APPROVE', role: 'DISTRICT', officer_id: 'dev' });
  ok(spoof.status >= 400, 'role or officer id in the body is ignored', spoof.status);
  const stranger = await call(U.ravi, '/batches/' + id);
  ok(stranger.status >= 400, "other centre cannot open Anika's batch", stranger.status);
  const ravisList = await call(U.ravi, '/batches');
  ok(!ravisList.json.some?.(b => b.id === id), "other centre's list does not include it");
  const anon = await call(null, '/batches');
  ok(anon.status === 401, 'no token means 401', anon.status);
  const fake = await call({ token: 'abc.def.ghi' }, '/batches');
  ok(fake.status === 401, 'forged token means 401', fake.status);
  const pdf = await fetch(API + '/c/' + 'a'.repeat(64) + '/pdf');
  ok(pdf.status >= 400, 'guessing a certificate token gets nothing', pdf.status);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);