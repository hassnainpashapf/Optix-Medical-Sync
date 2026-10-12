// Cloudflare Pages front door for Optix Medical Sync: the app itself (Node + SQLite) runs on the origin server;
// this Function forwards every request there, so the public address is the Cloudflare one and the server's own
// address is never shown to visitors.
const ORIGIN = 'https://hospital.150.230.52.29.sslip.io'

export async function onRequest({ request }) {
  const url = new URL(request.url)
  /* the server accepts a write only from its own address, so the browser's Origin is checked HERE against this address (cross-site
     requests are refused) and then shown to the server as its own */
  const origin = request.headers.get('Origin')
  if (origin && origin !== url.origin) return new Response(JSON.stringify({ error: 'Bad origin' }), { status: 403, headers: { 'Content-Type': 'application/json' } })
  const upstream = new Request(ORIGIN + url.pathname + url.search, request)
  if (origin) upstream.headers.set('Origin', ORIGIN)
  const referer = request.headers.get('Referer')
  if (referer && referer.startsWith(url.origin)) upstream.headers.set('Referer', ORIGIN + referer.slice(url.origin.length))
  upstream.headers.set('X-Forwarded-Host', url.host)
  upstream.headers.set('X-Forwarded-Proto', 'https')
  upstream.headers.delete('cf-connecting-ip')
  const res = await fetch(upstream, { redirect: 'manual' })
  const out = new Response(res.body, res)
  const loc = out.headers.get('Location')
  if (loc && loc.startsWith(ORIGIN)) out.headers.set('Location', url.origin + loc.slice(ORIGIN.length))
  return out
}
