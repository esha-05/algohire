import { useEffect, useState, useCallback } from 'react';

const NEED: any = { DISTRICT_REVIEW: 2, QUALITY_REVIEW: 1, STATE_REVIEW: 1 };
const STEP_ROLE: any = { DISTRICT_REVIEW: 'DISTRICT', QUALITY_REVIEW: 'QUALITY', STATE_REVIEW: 'STATE' };
const STEP_INDEX: any = { DRAFT: 0, RETURNED: 0, DISTRICT_REVIEW: 1, QUALITY_REVIEW: 2, STATE_REVIEW: 3, ISSUING: 4, ISSUED: 4 };
const STATUS_TONE: any = { DRAFT: '', RETURNED: 'amber', DISTRICT_REVIEW: 'blue', QUALITY_REVIEW: 'blue', STATE_REVIEW: 'blue', ISSUING: 'amber', ISSUED: 'green', REJECTED: 'red' };

async function api(path: string, token: string, method = 'GET', body?: any) {
  const r = await fetch('/api' + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw j;
  return j;
}
const fmt = (e: any) => (e?.errors ? e.errors.map((x: any) => `Row ${x.row}: ${x.message}`).join('\n') : e?.error || 'Something went wrong');
const label = (s: string) => s.replace('_', ' ').toLowerCase().replace(/^\w/, c => c.toUpperCase());

export default function App() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => { const f = () => setHash(location.hash); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  const m = hash.match(/^#\/verify\/([a-f0-9]{64})$/);
  return m ? <Verify token={m[1]} /> : <Portal />;
}

// Public page: no login. This is where the QR code on a certificate leads.
function Verify({ token }: { token: string }) {
  const [d, setD] = useState<any>(null);
  useEffect(() => { fetch('/api/verify/' + token).then(r => r.json()).then(setD); }, [token]);
  if (!d) return <p className="center">Checking…</p>;
  const ok = d.status === 'VALID';
  return <div className="verify"><div className={'verify-card' + (ok ? '' : ' v-bad')}>
    <div className="verify-icon">{ok ? '✔' : '✖'}</div>
    <h1>{ok ? 'Genuine certificate' : d.status === 'CANCELLED' ? 'Cancelled – no longer valid' : 'Certificate not found'}</h1>
    {d.serial && <dl className="verify-meta">
      <dt>Serial</dt><dd>{d.serial}</dd>
      <dt>Holder</dt><dd>{d.holder}</dd>
      <dt>Course</dt><dd>{d.course}</dd>
    </dl>}
  </div></div>;
}

function Portal() {
  const [users, setUsers] = useState<any[]>([]);
  const [me, setMe] = useState<any>(null);
  const [token, setToken] = useState('');
  const [tick, setTick] = useState(0);
  const [toast, setToast] = useState('');

  async function login(id: string) {
    const j = await fetch('/api/auth/demo-login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: id }) }).then(r => r.json());
    setToken(j.token); setMe(j.user);
  }
  useEffect(() => { fetch('/api/demo-users').then(r => r.json()).then(u => { setUsers(u); login('anika'); }); }, []);
  // Realtime: any server event bumps `tick`, components refetch through the normal authorised endpoints.
  useEffect(() => {
    if (!token) return;
    const es = new EventSource('/api/events?token=' + token);
    es.onmessage = e => { const ev = JSON.parse(e.data); setTick(t => t + 1); if (ev.type === 'batch.escalated') setToast('⚠ A batch is stuck past its SLA'); };
    return () => es.close();
  }, [token]);

  return <>
    <header className="top">
      <div className="brand">
        <div className="mark">C</div>
        <div><h1>CertiFlow</h1><div className="tag">Skilling certificate issuance and verification</div></div>
      </div>
      {toast && <button className="toast" onClick={() => setToast('')}>{toast}</button>}
      <div className="who">
        <label><span className="who-label">Acting as</span>
          <select value={me?.id || ''} onChange={e => login(e.target.value)}>
            {users.map(u => <option key={u.id} value={u.id}>{u.name} ({u.role}{u.district ? ' · ' + u.district : ''})</option>)}
          </select>
        </label>
        {me && <span className="role-chip">{me.role}</span>}
      </div>
    </header>
    {me && <Main key={token} me={me} token={token} tick={tick} />}
  </>;
}

function Main({ me, token, tick }: any) {
  const [list, setList] = useState<any[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  useEffect(() => { api('/batches', token).then(setList); }, [token, tick]);

  const needsMe = list.filter(b => STEP_ROLE[b.status] === me.role && !b.my_approved).length;
  const inReview = list.filter(b => NEED[b.status]).length;
  const issued = list.filter(b => b.status === 'ISSUED').length;
  const stuck = list.filter(b => b.escalated_at).length;

  return <main>
    <div className="stats">
      <div className="stat"><div className="stat-n">{list.length}</div><div className="stat-l">Batches</div></div>
      <div className={'stat' + (needsMe ? ' hot' : '')}><div className="stat-n">{needsMe}</div><div className="stat-l">Waiting for you</div></div>
      <div className="stat"><div className="stat-n">{inReview}</div><div className="stat-l">In review</div></div>
      <div className={'stat' + (stuck ? ' bad' : '')}><div className="stat-n">{issued}</div><div className="stat-l">Issued{stuck ? ` · ${stuck} stuck` : ''}</div></div>
    </div>
    <div className="grid">
      <aside>
        {me.role === 'CENTRE' && <NewBatch token={token} onDone={setSel} />}
        {me.role === 'STATE' && <Rules token={token} />}
        <div className="list-head"><h3 style={{ margin: 0 }}>{me.role === 'CENTRE' ? 'My batches' : 'Batches'}</h3></div>
        {list.map(b => <button key={b.id} className={'item' + (sel === b.id ? ' sel' : '')} onClick={() => setSel(b.id)}>
          <div className="item-top">
            <div><b>{b.title}</b><div className="small muted">{b.centre_name} · {b.size} candidates</div></div>
            <span className={'badge ' + (STATUS_TONE[b.status] || '')}>{label(b.status)}</span>
          </div>
          <div className="item-tags">
            {NEED[b.status] && <span className="badge">{b.approvals}/{NEED[b.status]} approvals</span>}
            {b.escalated_at && <span className="badge red">Stuck</span>}
            {STEP_ROLE[b.status] === me.role && !b.my_approved && <span className="badge amber">Needs you</span>}
          </div>
        </button>)}
        {!list.length && <div className="empty">No batches yet.</div>}
      </aside>
      <section>
        {sel ? <Detail key={sel} id={sel} me={me} token={token} tick={tick} /> : <div className="empty big">Select a batch to see its candidates, approvals and certificates.</div>}
      </section>
    </div>
  </main>;
}

function NewBatch({ token, onDone }: any) {
  const [f, setF] = useState({ title: '', course: '', csv: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    try { setErr(''); setBusy(true); const j = await api('/batches', token, 'POST', f); setF({ title: '', course: '', csv: '' }); onDone(j.id); }
    catch (e) { setErr(fmt(e)); }
    finally { setBusy(false); }
  };
  return <div className="card">
    <b>New batch</b>
    <input placeholder="Batch title" value={f.title} onChange={e => setF({ ...f, title: e.target.value })} />
    <input placeholder="Course (e.g. Python Programming)" value={f.course} onChange={e => setF({ ...f, course: e.target.value })} />
    <input type="file" accept=".csv" onChange={async e => { const file = e.target.files?.[0]; if (file) setF({ ...f, csv: await file.text() }); }} />
    <div className="small muted">CSV with columns <code>name,phone,attendance,theory_marks,practical_marks</code> (<a href="/sample.csv">sample</a>){f.csv && ` · ${Math.max(f.csv.trim().split('\n').length - 1, 0)} rows loaded`}</div>
    <div className="actions"><button className="primary" disabled={busy} onClick={submit}>{busy ? 'Checking…' : 'Create draft'}</button></div>
    {err && <pre className="err">{err}</pre>}
  </div>;
}

function Tracker({ b }: any) {
  const big = b.size >= 50;
  const steps = [{ k: 0, n: 'Draft' }, { k: 1, n: 'District' }, ...(big ? [{ k: 2, n: 'Quality' }] : []), { k: 3, n: 'State' }, { k: 4, n: 'Issued' }];
  const cur = STEP_INDEX[b.status] ?? 0;
  const rejected = b.status === 'REJECTED';
  return <ol className="tracker">{steps.map(s => {
    const done = !rejected && (s.k < cur || (b.status === 'ISSUED' && s.k === 4));
    const isCur = !done && s.k === cur;
    const cls = rejected && isCur ? 'rej' : done ? 'done' : isCur ? 'cur' : '';
    return <li key={s.k} className={cls}><div className="dot">{done ? '✓' : rejected && isCur ? '✕' : ''}</div>{s.n}</li>;
  })}</ol>;
}

function Detail({ id, me, token, tick }: any) {
  const [d, setD] = useState<any>(null);
  const [msg, setMsg] = useState('');
  const load = useCallback(() => api('/batches/' + id, token).then(setD).catch(e => setMsg(fmt(e))), [id, token]);
  useEffect(() => { load(); }, [load, tick]);
  useEffect(() => { setMsg(''); }, [d?.batch?.status]);
  if (!d) return <div className="card">{msg ? <pre className="err">{msg}</pre> : 'Loading…'}</div>;
  const b = d.batch;
  const act = async (fn: () => Promise<any>) => { try { setMsg(''); await fn(); load(); } catch (e) { setMsg(fmt(e)); } };
  const decide = (decision: string) => {
    const reason = decision === 'APPROVE' ? undefined : prompt('Reason (required)') || '';
    if (decision !== 'APPROVE' && !reason) return;
    act(() => api(`/batches/${id}/decision`, token, 'POST', { decision, reason }));
  };
  const canDecide = STEP_ROLE[b.status] === me.role && !d.approvals.some((a: any) => a.officer_id === me.id);
  const editable = me.role === 'CENTRE' && ['DRAFT', 'RETURNED'].includes(b.status);
  const certs = d.certificates as any[];
  const sent = certs.filter(c => c.delivery_status === 'SENT').length;
  const qualify = d.candidates.filter((c: any) => c.eligible || c.override_reason).length;

  return <div className="card">
    <div className="detail-head">
      <div>
        <h3 style={{ margin: 0 }}>{b.title}</h3>
        <div className="small muted">{b.centre_name} · {b.course} · round {b.round}</div>
      </div>
      <span className={'badge ' + (STATUS_TONE[b.status] || '')}>{label(b.status)}</span>
    </div>
    <Tracker b={b} />
    {d.rule && <div className="small muted">Judged by rule v{d.rule.version}: attendance ≥ {+d.rule.min_attendance}, theory ≥ {+d.rule.min_theory}, practical ≥ {+d.rule.min_practical}</div>}
    {b.status === 'RETURNED' && <div className="notice amber" style={{ marginTop: 12 }}>Returned: {b.return_reason}</div>}
    {msg && <pre className="err">{msg}</pre>}
    {editable && <div className="actions">
      <label className="filebtn">Replace candidates (CSV)
        <input type="file" accept=".csv" onChange={async e => { const f = e.target.files?.[0]; if (f) act(async () => api(`/batches/${id}/candidates`, token, 'PUT', { csv: await f.text() })); e.target.value = ''; }} />
      </label>
      <button className="primary" onClick={() => act(() => api(`/batches/${id}/submit`, token, 'POST'))}>{b.status === 'RETURNED' ? 'Fix done – resubmit' : 'Send for approval'}</button>
    </div>}
    {canDecide && <div className="actions">
      <button className="primary" onClick={() => decide('APPROVE')}>Approve</button>
      <button className="ghost" onClick={() => decide('RETURN')}>Send back</button>
      <button className="danger" onClick={() => decide('REJECT')}>Reject</button>
    </div>}

    {certs.length > 0 ? <>
      <h3>Certificates</h3>
      <div className="small muted">{sent} of {certs.length} delivered</div>
      <div className="progress"><div style={{ width: `${certs.length ? (sent / certs.length) * 100 : 0}%` }} /></div>
      <div className="scroll"><table>
        <thead><tr><th>Serial</th><th>Name</th><th>Delivery</th><th></th></tr></thead>
        <tbody>{certs.map((c: any) => <tr key={c.id}>
          <td className="mono">{c.serial}</td><td>{c.name}</td>
          <td><span className={'badge ' + (c.status === 'CANCELLED' ? 'red' : c.delivery_status === 'SENT' ? 'green' : c.delivery_status === 'FAILED' ? 'red' : 'amber')}>{c.status === 'CANCELLED' ? 'Cancelled' : label(c.delivery_status)}</span> <span className="small muted">{c.delivery_attempts} tries</span></td>
          <td><div className="row-actions">
            <a href={`#/verify/${c.token}`} target="_blank">Verify</a>
            {c.status === 'VALID' && <a href={`/api/c/${c.token}/pdf`}>PDF</a>}
            {me.role === 'STATE' && c.status === 'VALID' && <button className="danger sm" onClick={() => { const reason = prompt('Reason for cancelling'); if (reason) act(() => api(`/certificates/${c.id}/cancel`, token, 'POST', { reason })); }}>Cancel</button>}
          </div></td>
        </tr>)}</tbody>
      </table></div>
    </> : <>
      <h3>Candidates ({d.candidates.length}) · {qualify} qualify</h3>
      <div className="scroll"><table>
        <thead><tr><th>Name</th><th>Phone</th><th>Attendance · Theory · Practical</th><th>Result</th></tr></thead>
        <tbody>{d.candidates.slice(0, 100).map((c: any) => <tr key={c.id}>
          <td>{c.name}</td><td className="mono">{c.phone}</td>
          <td className="small">{c.attendance == null ? '–' : `${+c.attendance}% · ${+c.theory} · ${+c.practical}`}</td>
          <td><div className="row-actions">
            {c.eligible ? <span className="badge green">Qualifies</span>
              : c.override_reason ? <span className="badge amber">Override: {c.override_reason}</span>
              : <span className="badge red">{(c.reasons || []).join(', ')}</span>}
            {me.role === 'STATE' && !c.eligible && !c.override_reason && STEP_ROLE[b.status] && <button className="ghost sm" onClick={() => { const reason = prompt('Override reason (required)'); if (reason) act(() => api(`/candidates/${c.id}/override`, token, 'POST', { reason })); }}>Override</button>}
          </div></td>
        </tr>)}</tbody>
      </table></div>
      {d.candidates.length > 100 && <div className="small muted">Showing the first 100 of {d.candidates.length}.</div>}
    </>}

    <h3>Timeline</h3>
    <ul className="timeline">{[...d.timeline].reverse().slice(0, 40).map((t: any, i: number) => <li key={i}>
      <span className="small muted">{new Date(t.ts).toLocaleTimeString()}</span>
      <span><b>{t.actor}</b> · {t.action}</span>
      {t.details && Object.keys(t.details).length > 0 && <details><summary className="small muted">details</summary><code>{JSON.stringify(t.details)}</code></details>}
    </li>)}</ul>
  </div>;
}

function Rules({ token }: any) {
  const [rules, setRules] = useState<any[]>([]);
  const [f, setF] = useState<any>({ course: '', minAttendance: 80, minTheory: 40, minPractical: 40 });
  const [err, setErr] = useState('');
  const load = () => api('/courses/rules', token).then(setRules);
  useEffect(() => { load(); }, []);
  return <div className="card">
    <b>Course rules (state office)</b>
    <div style={{ margin: '8px 0' }}>{rules.map(r => <div key={r.id} className="small muted">{r.course} v{r.version}: attendance ≥ {+r.min_attendance}, theory ≥ {+r.min_theory}, practical ≥ {+r.min_practical}</div>)}</div>
    <input placeholder="Course (existing name = new version)" value={f.course} onChange={e => setF({ ...f, course: e.target.value })} />
    {['minAttendance', 'minTheory', 'minPractical'].map(k => <input key={k} type="number" title={k} placeholder={k} value={f[k]} onChange={e => setF({ ...f, [k]: Number(e.target.value) })} />)}
    <div className="actions"><button className="primary" onClick={async () => { try { setErr(''); await api('/courses/rules', token, 'POST', f); load(); } catch (e) { setErr(fmt(e)); } }}>Save new version</button></div>
    {err && <pre className="err">{err}</pre>}
  </div>;
}