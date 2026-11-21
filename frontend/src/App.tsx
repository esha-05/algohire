import { useEffect, useState, useCallback } from 'react';

const NEED: any = { DISTRICT_REVIEW: 2, QUALITY_REVIEW: 1, STATE_REVIEW: 1 };
const STEP_ROLE: any = { DISTRICT_REVIEW: 'DISTRICT', QUALITY_REVIEW: 'QUALITY', STATE_REVIEW: 'STATE' };
const LABEL: any = {
  DRAFT: 'Draft', RETURNED: 'Returned', REJECTED: 'Rejected',
  DISTRICT_REVIEW: 'District review', QUALITY_REVIEW: 'Quality review', STATE_REVIEW: 'State review',
  ISSUING: 'Issuing', ISSUED: 'Issued',
};
const TONE: any = {
  DRAFT: 'grey', RETURNED: 'amber', REJECTED: 'red',
  DISTRICT_REVIEW: 'blue', QUALITY_REVIEW: 'blue', STATE_REVIEW: 'blue',
  ISSUING: 'amber', ISSUED: 'green',
};

async function api(path: string, token: string, method = 'GET', body?: any) {
  const r = await fetch('/api' + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw j;
  return j;
}
const fmt = (e: any) =>
  e?.errors ? e.errors.map((x: any) => `Row ${x.row}: ${x.message}`).join('\n') : e?.error || 'Something went wrong';

const Badge = ({ s }: { s: string }) => <span className={'badge ' + (TONE[s] || 'grey')}>{LABEL[s] || s}</span>;

export default function App() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const f = () => setHash(location.hash);
    addEventListener('hashchange', f);
    return () => removeEventListener('hashchange', f);
  }, []);
  const m = hash.match(/^#\/verify\/([a-f0-9]{64})$/);
  return m ? <Verify token={m[1]} /> : <Portal />;
}

// Public page: no login. This is where the QR code on a certificate leads.
function Verify({ token }: { token: string }) {
  const [d, setD] = useState<any>(null);
  useEffect(() => {
    fetch('/api/verify/' + token).then(r => r.json()).then(setD).catch(() => setD({ status: 'NOT_FOUND' }));
  }, [token]);
  if (!d) return <p className="center">Checking certificate…</p>;
  const ok = d.status === 'VALID';
  const cancelled = d.status === 'CANCELLED';
  return (
    <div className="verify">
      <div className={'verify-card ' + (ok ? 'v-ok' : 'v-bad')}>
        <div className="verify-icon">{ok ? '✔' : '✖'}</div>
        <h1>{ok ? 'Genuine certificate' : cancelled ? 'Certificate cancelled' : 'Certificate not found'}</h1>
        <p className="muted">
          {ok
            ? 'This certificate was issued through CertiFlow and is currently valid.'
            : cancelled
            ? 'This certificate was issued but has since been cancelled. It is no longer valid.'
            : 'No certificate matches this code. It may be forged or mistyped.'}
        </p>
        {d.serial && (
          <dl className="verify-meta">
            <dt>Serial</dt><dd>{d.serial}</dd>
            <dt>Holder</dt><dd>{d.holder}</dd>
            <dt>Course</dt><dd>{d.course}</dd>
          </dl>
        )}
      </div>
    </div>
  );
}

function Portal() {
  const [users, setUsers] = useState<any[]>([]);
  const [me, setMe] = useState<any>(null);
  const [token, setToken] = useState('');
  const [tick, setTick] = useState(0);
  const [toast, setToast] = useState('');

  async function login(id: string) {
    const j = await fetch('/api/auth/demo-login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: id }),
    }).then(r => r.json());
    setToken(j.token);
    setMe(j.user);
  }
  useEffect(() => {
    fetch('/api/demo-users').then(r => r.json()).then(u => { setUsers(u); login('anika'); });
  }, []);
  // Realtime: any server event bumps `tick`; components refetch through the normal authorised endpoints.
  useEffect(() => {
    if (!token) return;
    const es = new EventSource('/api/events?token=' + token);
    es.onmessage = e => {
      const ev = JSON.parse(e.data);
      setTick(t => t + 1);
      if (ev.type === 'batch.escalated') setToast('A batch is stuck past its SLA');
    };
    return () => es.close();
  }, [token]);

  return (
    <>
      <header className="top">
        <div className="brand">
          <span className="mark">C</span>
          <div>
            <h1>CertiFlow</h1>
            <span className="tag">Training certificate approvals</span>
          </div>
        </div>
        {toast && <button className="toast" onClick={() => setToast('')}>{toast} (dismiss)</button>}
        <div className="who">
          {me && <span className="role-chip">{me.role}{me.district ? ' · ' + me.district : ''}</span>}
          <label>
            <span className="who-label">Demo user</span>
            <select value={me?.id || ''} onChange={e => login(e.target.value)}>
              {users.map(u => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.role}{u.district ? ' · ' + u.district : ''})
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>
      {me && <Main key={token} me={me} token={token} tick={tick} />}
    </>
  );
}

function Main({ me, token, tick }: any) {
  const [list, setList] = useState<any[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'mine'>('all');

  useEffect(() => { api('/batches', token).then(setList).catch(() => {}); }, [token, tick]);

  const needsMe = (b: any) => STEP_ROLE[b.status] === me.role && !b.my_approved;
  const shown = filter === 'mine' ? list.filter(needsMe) : list;

  // Open the first batch automatically so the right side is never blank.
  useEffect(() => {
    if (shown.length && !shown.some(b => b.id === sel)) setSel(shown[0].id);
    if (!shown.length && sel && filter === 'mine') setSel(null);
  }, [shown, sel, filter]);

  const stats = {
    total: list.length,
    mine: list.filter(needsMe).length,
    stuck: list.filter(b => b.escalated_at).length,
    issued: list.filter(b => b.status === 'ISSUED').length,
  };

  return (
    <main>
      <section className="stats">
        <Stat n={stats.total} l="Batches" />
        <Stat n={stats.mine} l="Waiting for you" hot={stats.mine > 0} />
        <Stat n={stats.stuck} l="Stuck past SLA" bad={stats.stuck > 0} />
        <Stat n={stats.issued} l="Fully issued" />
      </section>

      <div className="grid">
        <aside>
          {me.role === 'CENTRE' && <NewBatch token={token} onDone={setSel} />}
          <div className="list-head">
            <h2>{me.role === 'CENTRE' ? 'My batches' : 'Batches'}</h2>
            <div className="seg">
              <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>All</button>
              <button className={filter === 'mine' ? 'on' : ''} onClick={() => setFilter('mine')}>Needs me</button>
            </div>
          </div>
          {shown.map(b => (
            <button key={b.id} className={'item' + (sel === b.id ? ' sel' : '')} onClick={() => setSel(b.id)}>
              <div className="item-top">
                <b>{b.title}</b>
                <Badge s={b.status} />
              </div>
              <div className="muted small">{b.centre_name} · {b.size} candidates</div>
              <div className="item-tags">
                {NEED[b.status] && <span className="badge grey">{b.approvals}/{NEED[b.status]} approvals</span>}
                {b.escalated_at && <span className="badge red">Stuck</span>}
                {needsMe(b) && <span className="badge green">Needs you</span>}
              </div>
            </button>
          ))}
          {!shown.length && (
            <div className="empty">
              {filter === 'mine'
                ? 'Nothing is waiting for you right now.'
                : me.role === 'CENTRE'
                ? 'No batches yet. Upload a CSV above to create your first draft.'
                : 'No batches have reached you yet.'}
            </div>
          )}
        </aside>
        <section>
          {sel ? <Detail key={sel} id={sel} me={me} token={token} tick={tick} /> : <div className="empty big">Select a batch to see its approvals, certificates and history.</div>}
        </section>
      </div>
    </main>
  );
}

function Stat({ n, l, hot, bad }: { n: number; l: string; hot?: boolean; bad?: boolean }) {
  return (
    <div className={'stat' + (hot ? ' hot' : '') + (bad ? ' bad' : '')}>
      <div className="stat-n">{n}</div>
      <div className="stat-l">{l}</div>
    </div>
  );
}

function NewBatch({ token, onDone }: any) {
  const [f, setF] = useState({ title: '', course: '', csv: '' });
  const [fileName, setFileName] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const rows = f.csv ? f.csv.split('\n').filter(x => x.trim()).length - 1 : 0;

  async function create() {
    if (busy) return;
    if (!f.title.trim() || !f.course.trim() || !f.csv) {
      setErr('Enter a batch title, a course, and choose a CSV file.');
      return;
    }
    setBusy(true);
    try {
      setErr('');
      const j = await api('/batches', token, 'POST', f);
      setF({ title: '', course: '', csv: '' });
      setFileName('');
      onDone(j.id);
    } catch (e) {
      setErr(fmt(e));
    }
    setBusy(false);
  }

  return (
    <div className="card">
      <h2>New batch</h2>
      <input placeholder="Batch title, e.g. September retail batch" value={f.title} onChange={e => setF({ ...f, title: e.target.value })} />
      <input placeholder="Course, e.g. Retail Sales" value={f.course} onChange={e => setF({ ...f, course: e.target.value })} />
      <input
        type="file"
        accept=".csv"
        onChange={async e => {
          const file = e.target.files?.[0];
          if (file) { setF({ ...f, csv: await file.text() }); setFileName(file.name); }
        }}
      />
      <p className="muted small">
        CSV with columns <code>name,phone</code>. <a href="/sample.csv">Download sample</a>
        {f.csv && ` · ${fileName}: ${rows} rows loaded`}
      </p>
      <button className="primary" disabled={busy} onClick={create}>{busy ? 'Creating…' : 'Create draft'}</button>
      {err && <pre className="err">{err}</pre>}
    </div>
  );
}

function Tracker({ b, bigBatch }: { b: any; bigBatch: boolean }) {
  const steps = [
    { k: 'DRAFT', l: 'Centre' },
    { k: 'DISTRICT_REVIEW', l: 'District (2)' },
    ...(bigBatch ? [{ k: 'QUALITY_REVIEW', l: 'Quality' }] : []),
    { k: 'STATE_REVIEW', l: 'State' },
    { k: 'ISSUING', l: 'Issuing' },
    { k: 'ISSUED', l: 'Issued' },
  ];
  let idx = steps.findIndex(s => s.k === b.status);
  if (b.status === 'RETURNED') idx = 0;
  const rejected = b.status === 'REJECTED';
  return (
    <ol className="tracker">
      {steps.map((s, i) => {
        const done = b.status === 'ISSUED' || (!rejected && i < idx);
        const cur = !rejected && i === idx && b.status !== 'ISSUED';
        return (
          <li key={s.k} className={(done ? 'done ' : '') + (cur ? 'cur' : '')}>
            <span className="dot">{done ? '✔' : ''}</span>
            <span className="tl">{s.l}</span>
          </li>
        );
      })}
      {rejected && <li className="rej"><span className="dot">✖</span><span className="tl">Rejected</span></li>}
    </ol>
  );
}

function Detail({ id, me, token, tick }: any) {
  const [d, setD] = useState<any>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api('/batches/' + id, token).then(setD).catch(e => setMsg(fmt(e))), [id, token]);
  useEffect(() => { load(); }, [load, tick]);
  useEffect(() => { setMsg(''); }, [d?.batch?.status]);
  if (!d) return <div className="card"><p className="muted">{msg || 'Loading…'}</p></div>;

  const b = d.batch;
  // One action at a time: a double-click cannot send a second request.
  const act = async (fn: () => Promise<any>) => {
    if (busy) return;
    setBusy(true);
    try { setMsg(''); await fn(); await load(); } catch (e) { setMsg(fmt(e)); }
    setBusy(false);
  };
  const decide = (decision: string) => {
    const reason = decision === 'APPROVE' ? undefined : prompt('Reason (required)') || '';
    if (decision !== 'APPROVE' && !reason) return;
    act(() => api(`/batches/${id}/decision`, token, 'POST', { decision, reason }));
  };
  const canDecide = STEP_ROLE[b.status] === me.role && !d.approvals.some((a: any) => a.officer_id === me.id);
  const editable = me.role === 'CENTRE' && ['DRAFT', 'RETURNED'].includes(b.status);
  const bigBatch = (b.size ?? d.candidates.length) >= 50;
  const sent = d.certificates.filter((c: any) => c.delivery_status === 'SENT').length;
  const total = d.certificates.length;

  return (
    <div className="card detail">
      <div className="detail-head">
        <div>
          <h2>{b.title}</h2>
          <p className="muted small">{b.centre_name} · {b.course} · round {b.round}</p>
        </div>
        <Badge s={b.status} />
      </div>

      <Tracker b={b} bigBatch={bigBatch} />

      {NEED[b.status] && (
        <p className="small">
          {d.approvals.length}/{NEED[b.status]} approvals recorded
          {d.approvals.length > 0 && <> by {d.approvals.map((a: any) => a.officer_name || a.officer_id).join(', ')}</>}.
          {' '}Waiting for: <b>{STEP_ROLE[b.status]}</b> officers.
        </p>
      )}
      {b.status === 'RETURNED' && <p className="notice amber">Returned for fixes: {b.return_reason}</p>}
      {msg && <pre className="err">{msg}</pre>}

      {editable && (
        <div className="actions">
          <label className="filebtn">
            Replace CSV
            <input type="file" accept=".csv" onChange={async e => {
              const f = e.target.files?.[0];
              if (f) act(async () => api(`/batches/${id}/candidates`, token, 'PUT', { csv: await f.text() }));
            }} />
          </label>
          <button className="primary" disabled={busy} onClick={() => act(() => api(`/batches/${id}/submit`, token, 'POST'))}>
            {b.status === 'RETURNED' ? 'Fix done, resubmit' : 'Send for approval'}
          </button>
        </div>
      )}
      {canDecide && (
        <div className="actions">
          <button className="primary" disabled={busy} onClick={() => decide('APPROVE')}>Approve</button>
          <button className="ghost" disabled={busy} onClick={() => decide('RETURN')}>Send back</button>
          <button className="danger" disabled={busy} onClick={() => decide('REJECT')}>Reject</button>
        </div>
      )}

      {total > 0 ? (
        <>
          <h3>Certificates</h3>
          <div className="progress" title={`${sent} of ${total} delivered`}>
            <div style={{ width: (sent / total) * 100 + '%' }} />
          </div>
          <p className="muted small">{sent} of {total} delivered on WhatsApp</p>
          <div className="scroll">
            <table>
              <thead><tr><th>Serial</th><th>Name</th><th>Delivery</th><th></th></tr></thead>
              <tbody>
                {d.certificates.map((c: any) => (
                  <tr key={c.id}>
                    <td className="mono">{c.serial}</td>
                    <td>{c.name}</td>
                    <td>
                      <span className={'badge ' + (c.status === 'CANCELLED' ? 'red' : c.delivery_status === 'SENT' ? 'green' : 'amber')}>
                        {c.status === 'CANCELLED' ? 'Cancelled' : c.delivery_status}
                      </span>{' '}
                      <span className="muted small">{c.delivery_attempts} tries</span>
                    </td>
                    <td className="row-actions">
                      <a href={`#/verify/${c.token}`} target="_blank" rel="noreferrer">Verify</a>
                      {c.status === 'VALID' && <a href={`/api/c/${c.token}/pdf`}>PDF</a>}
                      {me.role === 'STATE' && c.status === 'VALID' && (
                        <button className="danger sm" disabled={busy} onClick={() => {
                          const reason = prompt('Reason for cancelling');
                          if (reason) act(() => api(`/certificates/${c.id}/cancel`, token, 'POST', { reason }));
                        }}>Cancel</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <>
          <h3>Candidates ({d.candidates.length})</h3>
          <div className="scroll">
            <table>
              <thead><tr><th>Name</th><th>Phone</th></tr></thead>
              <tbody>{d.candidates.slice(0, 50).map((c: any) => <tr key={c.id}><td>{c.name}</td><td className="mono">{c.phone}</td></tr>)}</tbody>
            </table>
          </div>
          {d.candidates.length > 50 && <p className="muted small">Showing the first 50 of {d.candidates.length}.</p>}
        </>
      )}

      <h3>History</h3>
      <ul className="timeline">
        {[...d.timeline].reverse().slice(0, 40).map((t: any, i: number) => (
          <li key={i}>
            <span className="muted small">{new Date(t.ts).toLocaleTimeString()}</span>
            <span><b>{t.actor}</b> {t.action}</span>
            <details>
              <summary className="muted small">details</summary>
              <code className="small">{JSON.stringify(t.details)}</code>
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}