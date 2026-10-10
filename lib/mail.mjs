// Minimal SMTP client (no dependencies). Supports implicit TLS (port 465), STARTTLS (587) and plain SMTP (dev servers),
// with AUTH PLAIN / LOGIN when credentials are set.
import net from 'node:net';
import tls from 'node:tls';

export function mailConfig() {
  const host = process.env.SMTP_HOST;
  if (!host) return null;
  const port = Number(process.env.SMTP_PORT || 587);
  return { host, port, user: process.env.SMTP_USER || '', pass: process.env.SMTP_PASS || '', from: process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@localhost', secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === '1' : port === 465 };
}

function reader(sock) {
  let buf = '', waiting = null, err = null;
  const lines = [];
  sock.setEncoding('utf8');
  sock.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\r\n')) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 2); } if (waiting) waiting(); });
  sock.on('error', (e) => { err = e; if (waiting) waiting(); });
  sock.on('close', () => { if (!err) err = new Error('Connection closed'); if (waiting) waiting(); });
  async function reply(timeout = 20000) {
    const t0 = Date.now(), out = [];
    for (;;) {
      while (lines.length) { const l = lines.shift(); out.push(l); if (/^\d{3} /.test(l)) return { code: +l.slice(0, 3), text: out.join('\n') }; }
      if (err) throw err;
      if (Date.now() - t0 > timeout) throw new Error('SMTP timeout');
      await new Promise((r) => { waiting = r; setTimeout(r, 500); });
    }
  }
  return { reply };
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const dotStuff = (s) => s.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
const safeHeader = (s) => String(s).replace(/[\r\n]+/g, ' ');

export async function sendSmtp(cfg, { to, subject, text }) {
  if (/[\r\n<>]/.test(to)) throw new Error('Invalid recipient');
  let sock = await new Promise((resolve, reject) => {
    const s = cfg.secure ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host }, () => resolve(s)) : net.connect({ host: cfg.host, port: cfg.port }, () => resolve(s));
    s.once('error', reject); s.setTimeout(30000, () => s.destroy(new Error('SMTP socket timeout')));
  });
  let rd = reader(sock);
  const send = (l) => sock.write(l + '\r\n');
  const expect = async (ok, what) => { const r = await rd.reply(); if (!ok.includes(r.code)) throw new Error(`SMTP ${what} failed: ${r.text}`); return r; };
  try {
    await expect([220], 'greeting');
    send('EHLO nexura'); let r = await expect([250], 'EHLO');
    if (!cfg.secure && /STARTTLS/i.test(r.text)) {
      send('STARTTLS'); await expect([220], 'STARTTLS');
      sock = tls.connect({ socket: sock, servername: cfg.host }); await new Promise((res, rej) => { sock.once('secureConnect', res); sock.once('error', rej); });
      rd = reader(sock); send('EHLO nexura'); r = await expect([250], 'EHLO');
    }
    if (cfg.user && /AUTH/i.test(r.text)) {
      if (/AUTH[^\n]*PLAIN/i.test(r.text)) { send('AUTH PLAIN ' + b64(`\0${cfg.user}\0${cfg.pass}`)); await expect([235], 'AUTH'); }
      else { send('AUTH LOGIN'); await expect([334], 'AUTH'); send(b64(cfg.user)); await expect([334], 'AUTH'); send(b64(cfg.pass)); await expect([235], 'AUTH'); }
    }
    const from = (cfg.from.match(/<([^>]+)>/) || [0, cfg.from])[1];
    send(`MAIL FROM:<${from}>`); await expect([250], 'MAIL FROM');
    send(`RCPT TO:<${to}>`); await expect([250, 251], 'RCPT TO');
    send('DATA'); await expect([354], 'DATA');
    const head = [`From: ${safeHeader(cfg.from)}`, `To: ${to}`, `Subject: =?UTF-8?B?${b64(safeHeader(subject))}?=`, `Date: ${new Date().toUTCString()}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64'].join('\r\n');
    const body = b64(text).replace(/(.{76})/g, '$1\r\n');
    send(head + '\r\n\r\n' + dotStuff(body) + '\r\n.'); await expect([250], 'message');
    send('QUIT');
  } finally { sock.destroy(); }
}
