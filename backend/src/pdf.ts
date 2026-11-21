import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { cfg } from './config';

// Idempotent: same certificate => same file. Written to a temp name then renamed, so a crash never leaves a half PDF.
export async function makePdf(c: any): Promise<string> {
  await fs.promises.mkdir(cfg.storage, { recursive: true });
  const file = path.join(cfg.storage, `${c.id}.pdf`);
  if (fs.existsSync(file)) return file;
  const qr = await QRCode.toBuffer(`${cfg.publicUrl}/#/verify/${c.token}`, { margin: 1, width: 150 });
  const tmp = `${file}.${process.pid}.tmp`;
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 50 });
  const ws = fs.createWriteStream(tmp);
  doc.pipe(ws);
  doc.rect(25, 25, doc.page.width - 50, doc.page.height - 50).stroke();
  doc.fontSize(30).text('Pragati Skills Mission', { align: 'center' }).moveDown(0.5);
  doc.fontSize(16).text('Certificate of Completion', { align: 'center' }).moveDown(1.5);
  doc.fontSize(14).text('This is to certify that', { align: 'center' }).moveDown(0.5);
  doc.fontSize(28).text(c.name, { align: 'center' }).moveDown(0.5);
  doc.fontSize(14).text(`has successfully completed the course ${c.course}`, { align: 'center' }).moveDown(1.5);
  doc.fontSize(11).text(`Certificate No: ${c.serial}`, { align: 'center' });
  doc.text(`Issued: ${new Date(c.issued_at).toISOString().slice(0, 10)}`, { align: 'center' });
  doc.image(qr, doc.page.width - 200, doc.page.height - 200, { width: 120 });
  doc.fontSize(8).text('Scan to verify', doc.page.width - 200, doc.page.height - 75, { width: 120, align: 'center' });
  doc.end();
  await new Promise<void>(r => ws.on("finish", () => r()));
  fs.renameSync(tmp, file);
  return file;
}
