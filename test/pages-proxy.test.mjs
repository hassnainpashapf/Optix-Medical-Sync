import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from '../functions/[[path]].js';

test('origin redirects stay on the public domain, including HTTP and protocol-relative redirects', async () => {
  const originalFetch = globalThis.fetch;
  const originHost = 'hospital.150.230.52.29.sslip.io';
  try {
    for (const location of [`https://${originHost}/login/`, `http://${originHost}/login/`, `//${originHost}/app?ws=test#patients`, '/app', 'https://accounts.google.com/login', `https://${originHost}.example.com/login`]) {
      globalThis.fetch = async () => new Response(null, { status: 302, headers: { Location: location } });
      const response = await onRequest({ request: new Request('https://optix-medical-sync.pages.dev/login') });
      const target = new URL(location, `https://${originHost}/login`);
      const expected = target.hostname === originHost ? `https://optix-medical-sync.pages.dev${target.pathname}${target.search}${target.hash}` : location;
      assert.equal(response.headers.get('Location'), expected);
    }
  } finally { globalThis.fetch = originalFetch; }
});
