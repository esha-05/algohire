import { parse } from 'csv-parse/sync';
export type Row = { name: string; phone: string };
type Err = { row: number; message: string };

const norm = (p: string) => {
  const d = p.replace(/[\s-]/g, '');
  if (/^\d{10}$/.test(d)) return '+91' + d;
  if (/^91\d{10}$/.test(d)) return '+' + d;
  return /^\+\d{10,14}$/.test(d) ? d : null;
};

// Validates the WHOLE sheet and reports every bad row (row 1 = header). Caller saves nothing if errors exist.
export function parseCsv(text: string): { rows: Row[]; errors: Err[] } {
  let recs: any[];
  try { recs = parse(text, { columns: (h: string[]) => h.map(x => x.trim().toLowerCase()), skip_empty_lines: true, trim: true, bom: true }); }
  catch (e: any) { return { rows: [], errors: [{ row: 0, message: 'Unreadable CSV: ' + e.message }] }; }
  const fail = (message: string) => ({ rows: [] as Row[], errors: [{ row: 0, message }] });
  if (!recs.length) return fail('No candidate rows found (expected header: name,phone)');
  if (!('name' in recs[0]) || !('phone' in recs[0])) return fail('Header must contain name and phone');
  if (recs.length > 2000) return fail('Max 2000 candidates per batch');
  const rows: Row[] = [], errors: Err[] = [], seen = new Map<string, number>();
  recs.forEach((r, i) => {
    const row = i + 2, name = String(r.name || ''), phone = norm(String(r.phone || ''));
    if (!/^\p{L}[\p{L} .'-]{1,79}$/u.test(name)) errors.push({ row, message: `Invalid name "${name}"` });
    if (!phone) errors.push({ row, message: `Invalid phone "${r.phone}"` });
    else if (seen.has(phone)) errors.push({ row, message: `Duplicate phone (same as row ${seen.get(phone)})` });
    else seen.set(phone, row);
    rows.push({ name, phone: phone || '' });
  });
  return { rows, errors };
}
