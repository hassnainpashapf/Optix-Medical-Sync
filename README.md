# Nexura Care

Hospital dashboard (appointments, staff, calendar, suppliers, stocks, transactions, peripherals) with a real backend.

- **Server:** `server.mjs`, plain Node (24+), no npm packages. Uses the built-in `node:sqlite`.
- **Database:** `data/nexura.db` (SQLite). Created on first start and filled with the demo data once.
- **First run:** open the app in the browser. With no users yet it shows **Create the Super Admin**: you choose the name, username and password. (Or set `ADMIN_PASSWORD` to create an `admin` Super Admin on start, for unattended installs.)

## Website

`/` is the marketing site (`site/`, with a Three.js 3D scene, vendored in `site/vendor/`). The app itself is at `/app`.
Behind a reverse proxy with HTTPS set `TRUST_PROXY=1`, `SECURE_COOKIES=1` and `ALLOWED_HOSTS=your.domain`.

## Run

```
npm start                 # http://localhost:3000
npm run reset-password    # prints a new admin password
npm run backup            # copies the database to data/backups/
```

Options (environment variables): `PORT`, `HOST` (default 127.0.0.1), `DATA_DIR`, `ADMIN_PASSWORD`, `ALLOWED_HOSTS`.

## Roles

Sign in as `admin` (Super Admin) and open **Users** to add people. Each role only sees and changes what it needs:

| Role | Can change | Can only view |
|---|---|---|
| Super Admin | everything, users, audit log, backups | |
| Doctor, Receptionist | appointments, patients | staff list |
| Accountant | transactions | appointments, patients, staff, suppliers, stocks |
| Pharmacist | suppliers, stocks | peripherals, staff list |

The server enforces this (a restricted role gets `403` and never receives data it cannot read); the screens just hide what is not allowed.

## What the app does

- **Notifications (bell):** pending requests, today's appointments, unpaid finished visits, low stock, devices out of service or due for service, failed and pending payments. Each item opens the right page.
- **Search (sidebar):** patients, doctors, upcoming appointments and suppliers, with arrow keys and Enter.
- **Reports:** revenue, purchases, net, completion rate, monthly chart, visit types, busiest doctors, top services, CSV export.
- **Audit log:** every create, update and delete, plus sign-ins, with who and when (Super Admin only).
- **Print:** appointment slip (reservation details) and payment receipt (transactions).
- **Backups:** the server saves a copy of the database to `data/backups/` at start and every 24 hours (last 7 kept). `npm run backup` makes one on demand.

- **Patients:** list, search, add, edit, delete (blocked while the patient has appointments). Each profile shows the patient's own appointments on a calendar and their reports.
- **Appointments:** requests are approved or rejected, approved ones are edited or cancelled. A booking is refused when the doctor already has an appointment at that time, does not work that weekday, or the slot overlaps the 1 to 2 pm break.
- **Calendar:** built from the approved appointments (day, week, month). Click a card for the reservation details, change its status, or edit it.
- **Dashboard:** every number (doctors, patients, appointments, pending requests, available doctors today, cash flow) is calculated from the stored data.
- **Files:** appointment attachments and patient reports are uploaded to `data/uploads/` (max 10MB each) and downloaded through the app.
- Staff, suppliers, stocks, transactions and peripherals can be added, edited and removed.

## Notes

- Every change you make in the app (approve/reject, add/remove, status changes, calendar reservation edits) is saved to the database straight away.
- To start again from the demo data, stop the server and delete the `data/` folder.
- The server listens on 127.0.0.1 only. Put it behind HTTPS (and set `ALLOWED_HOSTS`) before exposing it on a network.
- Doctor photos are stored in the database. Uploaded files live in `data/uploads/` and are listed in the `files` table.
- `data/backup-before-v2/` is a copy of the first (demo-only) database from before patients, calendar linking and uploads existed.
