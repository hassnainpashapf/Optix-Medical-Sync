# Optix Medical Sync

Multi-tenant hospital management SaaS. One Node process (Node 24+, **no npm packages**), SQLite storage.

| URL | What |
|---|---|
| `/` | Marketing website (Three.js 3D scene, live pricing from the platform) |
| `/privacy`, `/terms` | Privacy Policy and Terms of Use (disclose Google AdSense and cookies) |
| `/signup` | A hospital creates its own workspace and Super Admin, 14-day free trial |
| `/app` | The hospital app (sign in with workspace code, username, password) |
| `/platform` | Platform owner panel (you): workspaces, plans and prices, email outbox, platform log |

## How it is built

- **Tenants:** every hospital (workspace) has its **own SQLite file and uploads folder** in `data/tenants/<code>/`. A user session is bound to one workspace, so data cannot mix.
- **Platform database:** `data/platform.db` holds workspaces, plans, sessions, invite and reset tokens, the email outbox and the platform owner.
- **Roles inside a workspace:** Super Admin, Doctor, Receptionist, Accountant, Pharmacist. Enforced on the server (a restricted role never receives data it may not read).
- **Plans and limits:** Starter, Clinic, Hospital (edit prices and limits in the platform panel; the website reads them). Limits on users, patients and file storage are enforced on the server. After the trial a workspace is read-only until a plan is set. The owner can suspend, extend trials or change plans. **There is no payment gateway yet**, plans are changed by the owner.
- **Email:** invites, password reset and welcome mails. Set the SMTP variables below; without them mails are only recorded in the outbox (the owner can open one and copy its link).
- **Backups:** every workspace and the platform database are copied to `backups/` folders on start and every 24 hours (last 7 kept).
- **Audit logs:** per workspace (Super Admin) and for the platform (owner).

## Run

```
npm start                       # http://localhost:3000
npm run backup                  # back up the platform and every workspace now
npm run reset-owner-password    # new platform owner password
```

First run: open **/platform** and create the platform owner. Then hospitals can sign up at **/signup**.

The first start migrates an older single-hospital database (`data/nexura.db`) into a workspace called `demo`. If it has no user, open /platform, open the workspace and use **Reset the workspace Super Admin password**.

## One login for the Optix suite

This product keeps its own website, backend and data. People can sign in with their **Optix account** (the hub that Lab, Pharmacy and future products share):

- `Sign in with your Optix account` on `/app`, or arrive from another product's app chooser (`/app/#/sso?ticket=...`). The server asks the hub who the person is (`POST /api/hub/session`, ticket or token) and only lets in people who have the **hospital** product in an active business.
- The first **admin** of a business who opens the hospital gets a workspace (trial) created for that business; other people are added the first time they sign in, with the role set in the hub (`SUPER_ADMIN`, `DOCTOR`, `RECEPTIONIST`, `ACCOUNTANT`, `PHARMACIST`; default Receptionist). Plan limits still apply.
- Register the product once in the hub: Superadmin → Plans & Settings → Products → add `hospital` with the web address of this site's `/app` (for example `https://hospital.example.pk/app`) and the five roles above; then tick it for each business and for each person.
- Workspace code + password sign-in keeps working. `HUB_API` (default the production hub), `HUB_APP_ID` (`hospital`), `HUB_DISABLED=1` switch it off.
- `assets/optix-suite-sdk.js` is generated from the shared SDK: `node scripts/sync-sdk.mjs` (needs the `optix-suite-sdk` repo next to this one).
- Tests: `npm test`. Docker: `Dockerfile`, `deploy/docker-compose.yml`.

## Look and feel (shared Optix theme, light only)

The website, sign-up page, platform panel and the hospital app share one look with every Optix product: `optix-suite-sdk/theme/optix-theme.css` is the source of truth. There is no dark mode. Copy it into this repo with `node scripts/sync-theme.mjs` (needs the `optix-suite-sdk` repo next to this one). It writes `site/optix-theme.css` and `site/consent.js` (website) and `assets/optix-tokens.css` (tokens only, used by the app, sign-up and platform pages). Do not edit those copies by hand.

## Ads (Google AdSense, public pages only)

Ads are off until you set a publisher id. Set these environment variables (in `deploy/docker-compose.yml` they are `ADSENSE_CLIENT` and `ADSENSE_SLOT_HOME`; put them in the `.env` next to the compose file) and restart:

| Variable | Meaning |
|---|---|
| `ADSENSE_CLIENT` | Publisher id, `ca-pub-` plus digits. Turns on the consent banner, the "Ad choices" footer link and `/ads.txt` |
| `ADSENSE_SLOT_HOME` | Ad unit id (digits) for the one slot on the home page |

With both empty nothing from Google is loaded and `/ads.txt` returns 404. Ads load only after the visitor chooses (`site/consent.js`). Ads are **never** placed in `/app`, `/signup`, `/platform`, bills or reports (patient data; AdSense policy). The server hands the page its config from `/ads-config.js`.

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT`, `HOST` | `3000`, `127.0.0.1` | Listen address |
| `DATA_DIR` | `./data` | Where all databases and uploads live |
| `ALLOWED_HOSTS` | `localhost:PORT` | Comma list of accepted Host headers (set to your domain in production) |
| `APP_URL` | from request | Public base URL used in emails (for example `https://app.example.com`) |
| `TRUST_PROXY`, `SECURE_COOKIES` | off | Set to `1` behind an HTTPS reverse proxy |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SMTP_SECURE` | unset | Outgoing mail (465 = TLS, 587 = STARTTLS) |
| `SUPPORT_EMAIL` | unset | Shown in the app's Plan page for upgrade requests |
| `ADSENSE_CLIENT`, `ADSENSE_SLOT_HOME` | unset | Google AdSense (see Ads above) |
| `HUB_API`, `HUB_APP_ID`, `HUB_DISABLED` | production hub, `hospital`, off | The Optix account hub (see above) |

## Before going public

- Put it behind HTTPS (nginx, Caddy or Cloudflare) and set `TRUST_PROXY=1`, `SECURE_COOKIES=1`, `ALLOWED_HOSTS`, `APP_URL`.
- Set up SMTP so invites and password resets are delivered.
- Check the placeholder prices in the platform panel.
- Keep `data/` backed up off the server.
- Planned, not built: payment gateway, SMS reminders, per-tenant custom domains.
