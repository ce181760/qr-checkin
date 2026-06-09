# Event Check-In

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A tiny, easy-to-run attendee check-in web app. It collects a visitor's name and records a timestamp, and includes a simple admin interface to search, delete, and export attendance.

[Repository](https://github.com/ce181760/qr-checkin)

Purpose
- Fast check-in for small events using a QR code or direct link.
- Minimal data collected: attendee name + timestamp.

Quick start (5 minutes)
1. Open a terminal in the project folder (`Documents/event-checkin`).
2. Install dependencies:

```bash
npm install
```

3. Start the server:

```bash
npm start
```

4. Open the attendee page in your browser:

http://localhost:3000

5. Open the admin dashboard (staff only):

http://localhost:3000/admin

What you'll find
- Attendee form (`/`) — simple name input intended for QR placement.
- Admin dashboard (`/admin`) — view, search, delete, and export attendance.
- Admin account page (`/admin/account`) — change username, email, and password.

Files of interest
- `server.js` — Express server, API endpoints, and reminder scheduler.
- `public/` — static frontend files (attendee form, admin UI, scripts).
- `data/attendance.csv` — stored attendance records.
- `data/admin.json` — admin profile and reminder timestamps (DO NOT commit).
- `data/admin.example.json` — example admin file to copy to `data/admin.json` for local use.
- `.env.example` — example environment variables for admin overrides and SMTP settings.

Admin access
- Default admin (used for local testing):
	- Username: admin
	- Password: admin123

To override before starting the server (Windows PowerShell):

```powershell
$env:ADMIN_USER = 'myuser'
$env:ADMIN_PASS = 'mypassword'
npm start
```

Environment example

Copy `.env.example` to `.env` or set the variables in your environment. Use `data/admin.example.json` as a template and do not commit your real `data/admin.json` file.

Persistent data on Render
- Render's normal filesystem can reset on redeploys/restarts. To keep admin changes and CSV data, add a Render persistent disk and set `DATA_DIR` to the disk mount path, such as `/var/data`.
- With `DATA_DIR=/var/data`, the app stores `attendance.csv`, `users.csv`, and `admin.json` on the persistent disk instead of the project folder.
- To store admin username/password/email and check-in records in a database, add a Render Postgres database and set `DATABASE_URL`. When `DATABASE_URL` is present, admin profile changes and attendance records are saved in Postgres. `DATA_DIR` is still used for other local files such as `users.csv`.
- If your database requires SSL, set `DATABASE_SSL=true`.

Security notes
- The app currently stores the admin password in `data/admin.json`. This is convenient for a quick demo but insecure for production — consider enabling password hashing (bcrypt) and switching to server sessions or tokens.
- The server does not return admin passwords to the client; only safe profile fields are returned.

Email reminders
- The server can send monthly password reminder emails to the admin. To enable real email sending, set SMTP environment variables before starting the app (see `server.js` for variable names). If SMTP is not configured, reminders are skipped or logged.

Development notes
- Port: default is `3000` (change in `server.js` if needed).
- Install new dependencies with `npm install <package>` and restart the server.
- To run the server manually for debugging:

```bash
node server.js
```

Data and backups
- `data/attendance.csv` is a plain CSV. Back it up before bulk edits.
- `data/admin.json` holds admin profile info and reminder timestamps.

Next improvements (recommended)
- Hash admin passwords (bcrypt) and remove plaintext storage.
- Replace client-stored Basic auth with server sessions or JWTs.
- Add password strength validation and rate-limiting on login.

Questions or help
- If you want, I can implement password hashing and update login/profile flows — ask me to proceed.

---

Thank you for using Event Check-In — built for quick, private check-ins.
