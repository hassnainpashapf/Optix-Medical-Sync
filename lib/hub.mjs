/* The Optix account hub: one sign-in for all products of the suite (see docs/PRODUCT-INTEGRATION.md in the Lab repo).
   This product ("hospital") keeps its own website, backend and data; the hub only tells it who the person is, which business they
   belong to and which products they may open. No dependencies: plain fetch. */

export const HUB = {
  api: String(process.env.HUB_API || 'https://labpos-api.150.230.52.29.sslip.io').replace(/\/+$/, ''),
  appId: process.env.HUB_APP_ID || 'hospital',
  enabled: process.env.HUB_DISABLED !== '1',
};

/* roles this product registers in the hub (Superadmin > Plans & Settings > Products) -> the roles inside a workspace */
export const HUB_ROLES = [
  { value: 'SUPER_ADMIN', label: 'Super Admin', local: 'Super Admin' },
  { value: 'DOCTOR', label: 'Doctor', local: 'Doctor' },
  { value: 'RECEPTIONIST', label: 'Receptionist', local: 'Receptionist' },
  { value: 'ACCOUNTANT', label: 'Accountant', local: 'Accountant' },
  { value: 'PHARMACIST', label: 'Pharmacist', local: 'Pharmacist' },
];
export const localRoleOf = (hubRole) => (HUB_ROLES.find((r) => r.value === hubRole) || {}).local || null;

export class HubError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function hubFetch(path, { method = 'GET', body, token, fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(`${HUB.api}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new HubError(503, 'The Optix sign-in service cannot be reached. Try again in a moment.');
  }
  let json = {}; try { json = await res.json(); } catch { json = {}; }
  if (!res.ok) throw new HubError(res.status === 401 || res.status === 403 ? 401 : 503, res.status === 401 || res.status === 403 ? (json.error || 'This sign-in is not valid or has expired.') : 'The Optix sign-in service answered with an error.');
  return json;
}

/* Who is behind a one-time ticket (from the app chooser) or a hub token (from signing in with the Optix account)?
   -> { user, lab, apps, catalog, token } or throws HubError. Only a person with access to THIS product, in an active business, passes. */
export async function resolveHubIdentity({ ticket, token }, opts = {}) {
  if (!HUB.enabled) throw new HubError(404, 'Sign-in with an Optix account is switched off on this server.');
  let who;
  if (ticket) {
    const r = await hubFetch('/api/sso/exchange', { method: 'POST', body: { ticket: String(ticket) }, ...opts });
    who = { user: r.user, lab: r.lab, apps: r.apps || [], catalog: r.catalog || [], token: r.token };
  } else if (token) {
    const r = await hubFetch('/api/auth/whoami', { token: String(token), ...opts });
    who = { user: r.user, lab: r.lab, apps: r.apps || [], catalog: r.catalog || [], token: String(token) };
  } else throw new HubError(400, 'Nothing to sign in with.');
  if (!who.user || !who.lab) throw new HubError(401, 'This sign-in is not valid.');
  if (!who.apps.includes(HUB.appId)) throw new HubError(403, 'Your account does not have access to the Hospital app. Ask your administrator.');
  if (['suspended', 'expired'].includes(who.lab.status)) throw new HubError(403, 'This business account is not active. Contact support.');
  return who;
}

/* "Sign in / Sign up with Google": the browser only ever holds Google's credential; THIS server hands it to the hub, which checks it with
   Google (signature, audience = the Optix OAuth client, email verified) and answers { ok, email, name }. Nothing the browser says about
   who it is gets trusted. -> { email, name } (email lower-cased) or throws HubError (401 bad credential, 404 switched off, 503 hub trouble). */
export async function verifyGoogle(credential, opts = {}) {
  if (!HUB.enabled) throw new HubError(404, 'Sign-in with Google is switched off on this server.');
  const cred = typeof credential === 'string' ? credential.trim() : '';
  if (cred.length < 20 || cred.length > 6000) throw new HubError(401, 'This Google sign-in is not valid or has expired. Try again.');
  let res; const fetchImpl = opts.fetchImpl || fetch;
  try {
    res = await fetchImpl(`${HUB.api}/api/auth/google-verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential: cred }), signal: AbortSignal.timeout(8000) });
  } catch { throw new HubError(503, 'The Optix sign-in service cannot be reached. Try again in a moment.'); }
  let json = {}; try { json = await res.json(); } catch { json = {}; }
  if (res.status === 400 || res.status === 401 || res.status === 403) throw new HubError(401, 'This Google sign-in is not valid or has expired. Try again.');
  if (!res.ok) throw new HubError(503, 'The Optix sign-in service answered with an error.');
  const email = String(json.email || '').trim().toLowerCase();
  if (json.ok !== true || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 120) throw new HubError(401, 'This Google sign-in is not valid or has expired. Try again.');
  return { email, name: String(json.name || '').trim().slice(0, 80) };
}
