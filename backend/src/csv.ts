import { parse } from 'csv-parse/sync';
export type Row = { name: string; phone: string; attendance: number; theory: number; practical: number };
type Err = { row: number; message: string };

const norm = (p: string) => {
  const d = p.replace(/[\s-]/g, '');
  if (/^\d{10}$/.test(d)) return '+91' + d;
  if (/^91\d{10}$/.test(d)) return '+' + d;
  return /^\+\d{10,14}$/.test(d) ? d : null;
};

const num = (v: any) => { const s = String(v ?? '').trim(); const n = Number(s); return s !== '' && isFinite(n) && n >= 0 && n <= 100 ? n : null; };

// Validates the WHOLE sheet and reports every bad row (row 1 = header). Caller saves nothing if errors exist.
export function parseCsv(text: string): { rows: Row[]; errors: Err[] } {
  let recs: any[];
  try { recs = parse(text, { columns: (h: string[]) => h.map(x => x.trim().toLowerCase()), skip_empty_lines: true, trim: true, bom: true }); }
  catch (e: any) { return { rows: [], errors: [{ row: 0, message: 'Unreadable CSV: ' + e.message }] }; }
  const fail = (message: string) => ({ rows: [] as Row[], errors: [{ row: 0, message }] });
  if (!recs.length) return fail('No candidate rows found (expected header: name,phone)');
  for (const h of ['name', 'phone', 'attendance', 'theory_marks', 'practical_marks']) if (!(h in recs[0])) return fail(`Header must contain: name,phone,attendance,theory_marks,practical_marks (missing ${h})`);
  if (recs.length > 2000) return fail('Max 2000 candidates per batch');
  const rows: Row[] = [], errors: Err[] = [], seen = new Map<string, number>();
  recs.forEach((r, i) => {
    const row = i + 2, name = String(r.name || ''), phone = norm(String(r.phone || ''));
    if (!/^\p{L}[\p{L} .'-]{1,79}$/u.test(name)) errors.push({ row, message: `Invalid name "${name}"` });
    if (!phone) errors.push({ row, message: `Invalid phone "${r.phone}"` });
    else if (seen.has(phone)) errors.push({ row, message: `Duplicate phone (same as row ${seen.get(phone)})` });
    else seen.set(phone, row);
    const a = num(r.attendance), t = num(r.theory_marks), pr = num(r.practical_marks);
    if (a === null) errors.push({ row, message: `Attendance must be a number 0-100 (got "${r.attendance}")` });
    if (t === null) errors.push({ row, message: `Theory marks must be a number 0-100 (got "${r.theory_marks}")` });
    if (pr === null) errors.push({ row, message: `Practical marks must be a number 0-100 (got "${r.practical_marks}")` });
    rows.push({ name, phone: phone || '', attendance: a ?? 0, theory: t ?? 0, practical: pr ?? 0 });
  });
  return { rows, errors };
}
