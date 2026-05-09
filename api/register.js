/**
 * Vercel Serverless: primește nume + e-mail, trimite notificare și actualizează CSV (Blob).
 *
 * Variabile de mediu (Vercel → Project → Settings → Environment Variables):
 * - RESEND_API_KEY — cheie API Resend (https://resend.com)
 * - RESEND_FROM — expeditor verificat, ex: "Platformă <noreply@domeniul-tău.ro>"
 * - BLOB_READ_WRITE_TOKEN — din Vercel Blob (CSV: monumente/inregistrari.csv)
 * - BLOB_ACCESS — opțional: 'private' (implicit) sau 'public' dacă store-ul este public
 * - REGISTRATION_SHEET_WEBHOOK — opțional: URL Google Apps Script / Zapier care primește JSON { name, email, at }
 *
 * Este necesar cel puțin unul dintre: RESEND_API_KEY, BLOB_READ_WRITE_TOKEN, REGISTRATION_SHEET_WEBHOOK.
 */

const RECIPIENT = 'alexandru.dancu@gmail.com';
const CSV_PATHNAME = 'monumente/inregistrari.csv';

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeCsvField(s) {
  if (s == null) return '""';
  const t = String(s).replace(/"/g, '""');
  return `"${t}"`;
}

async function readJsonBody(req) {
  if (req.body != null && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body;
  }
  if (typeof req.body === 'string' && req.body.length) {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

async function sendResendEmail(name, email) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, skip: true };
  const from = process.env.RESEND_FROM || 'Platformă Monumente <onboarding@resend.dev>';
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      from,
      to: [RECIPIENT],
      subject: 'Înregistrare acces — platformă Monumente',
      html: `<p><strong>Nume:</strong> ${escapeHtml(name)}</p>
<p><strong>E-mail:</strong> ${escapeHtml(email)}</p>
<p><strong>Data (UTC):</strong> ${escapeHtml(new Date().toISOString())}</p>`,
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Resend ${r.status}: ${t}`);
  }
  return { ok: true };
}

async function appendCsvBlob(name, email) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return { ok: false, skip: true };
  const access = process.env.BLOB_ACCESS === 'public' ? 'public' : 'private';
  const { get, put } = await import('@vercel/blob');
  let csv = 'data_ora_utc,nume,email\n';
  const existing = await get(CSV_PATHNAME, { access, token });
  if (existing && existing.stream) {
    const txt = await new Response(existing.stream).text();
    if (txt && txt.trim()) csv = txt.endsWith('\n') ? txt : `${txt}\n`;
  }
  const row = [
    escapeCsvField(new Date().toISOString()),
    escapeCsvField(name),
    escapeCsvField(email),
  ].join(',');
  await put(CSV_PATHNAME, `${csv}${row}\n`, {
    access,
    addRandomSuffix: false,
    allowOverwrite: true,
    token,
  });
  return { ok: true };
}

async function postWebhook(name, email) {
  const url = process.env.REGISTRATION_SHEET_WEBHOOK;
  if (!url) return { ok: false, skip: true };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      email,
      at: new Date().toISOString(),
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Webhook ${r.status}: ${t}`);
  }
  return { ok: true };
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Metodă nepermisă.' });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return res.status(400).json({ error: 'Date JSON invalide.' });
  }

  const name = String(body.name || '')
    .trim()
    .slice(0, 200);
  const email = String(body.email || '')
    .trim()
    .slice(0, 320);
  if (!name || !email) {
    return res.status(400).json({ error: 'Completați numele și adresa de e-mail.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Adresa de e-mail nu este validă.' });
  }

  const results = { emailSent: false, csvUpdated: false, webhookSent: false };
  const warnings = [];

  try {
    const e = await sendResendEmail(name, email);
    if (e.ok) results.emailSent = true;
    else if (!e.skip) warnings.push(String(e.message || e));
  } catch (e) {
    warnings.push(e.message || String(e));
  }

  try {
    const b = await appendCsvBlob(name, email);
    if (b.ok) results.csvUpdated = true;
    else if (!b.skip) warnings.push(String(b.message || b));
  } catch (e) {
    warnings.push(e.message || String(e));
  }

  try {
    const w = await postWebhook(name, email);
    if (w.ok) results.webhookSent = true;
    else if (!w.skip) warnings.push(String(w.message || w));
  } catch (e) {
    warnings.push(e.message || String(e));
  }

  const ok = results.emailSent || results.csvUpdated || results.webhookSent;
  if (!ok) {
    return res.status(503).json({
      error:
        'Înregistrarea nu este configurată pe server. Adăugați în Vercel cel puțin una dintre: RESEND_API_KEY, BLOB_READ_WRITE_TOKEN, REGISTRATION_SHEET_WEBHOOK.',
      details: warnings,
    });
  }

  return res.status(200).json({
    ok: true,
    results,
    warnings: warnings.length ? warnings : undefined,
  });
};
