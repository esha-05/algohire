// Stand-in WhatsApp provider: fails (503), "hangs" (message delivered but the response is slow), and de-duplicates by Idempotency-Key.
const http = require('http');
const sent = new Map();
const FAIL = +process.env.FAIL_RATE || 0, HANG = +process.env.HANG_RATE || 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
http.createServer(async (req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.method === 'GET' && req.url.startsWith('/sent')) {
    const key = new URL(req.url, 'http://x').searchParams.get('key');
    return send(200, [...sent.values()].filter(m => !key || m.key === key));
  }
  if (req.method === 'POST' && req.url === '/messages') {
    let body = ''; for await (const c of req) body += c;
    const key = req.headers['idempotency-key'];
    if (!key) return send(400, { error: 'Idempotency-Key required' });
    const roll = Math.random();
    if (roll < FAIL) return send(503, { error: 'provider unavailable' });
    const dup = sent.has(key);
    if (!dup) sent.set(key, { key, ...JSON.parse(body), at: Date.now() });
    if (roll < FAIL + HANG) await sleep(5000);                 // delivered, but the caller times out before seeing it
    return send(200, { id: 'wamid.' + key, deduped: dup });
  }
  send(404, { error: 'not found' });
}).listen(4010, () => console.log('whatsapp mock on :4010', { FAIL, HANG }));
