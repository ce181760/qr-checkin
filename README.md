# Event Check-In

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A lightweight student attendance app for event drop-off and pick-up. Parents use the public page to record drop-off or pick-up, and staff use the admin dashboard to review attendance, late labels, reports, and account settings.

[Repository](https://github.com/ce181760/qr-checkin)

## What The App Does

- Lets parents choose `Drop off` or `Pick up`.
- Keeps one attendance session per student per event date.
- Records separate drop-off and pick-up parent names, times, and timestamps.
- Shows whether a student is currently `Present` or `Picked up`.
- Lets admins set late cutoff times for drop-off and pick-up.
- Marks late actions with `Late Drop-off` and `Late Pick-up` labels.
- Requires a late reason only when a parent is late.
- Keeps late reasons out of the main dashboard table.
- Includes late reasons in Print / Save PDF reports.
- Emails late reasons to the admin when SMTP is configured.
- Shows the school logo on the check-in, success, admin login, dashboard, and account pages.

## Parent Flow

Parents open the public check-in page:

```text
http://localhost:3000
```

They choose one action:

- `Drop off`
- `Pick up`

Then they enter:

- Student name
- Parent name

If the action is on time, the app saves the attendance update and shows the confirmation page.

If the action is late, the app asks for a required reason before saving:

```text
This drop-off is marked late. Please enter a reason.
```

or:

```text
This pick-up is marked late. Please enter a reason.
```

The confirmation page shows:

- Student
- Parent
- Action time
- `Late` or `On time`

## Admin Flow

Staff open the admin dashboard:

```text
http://localhost:3000/admin
```

The dashboard shows:

- Student
- Current status
- Late labels
- Event date
- Drop-off details
- Pick-up details
- Delete action

The dashboard table intentionally does not show full late reasons, so the table stays easy to scan.

## Late Cutoff Times

Admins can set:

- `Late drop-off at or after`
- `Late pick-up at or after`

Default values:

```text
Late drop-off at or after: 08:36
Late pick-up at or after: 13:35
```

If a parent submits at or after the cutoff, the action is marked late.

Examples:

- Drop-off at `8:36 AM` with cutoff `8:36 AM` is `Late`.
- Pick-up at `1:35 PM` with cutoff `1:35 PM` is `Late`.
- Pick-up before the late pick-up cutoff is allowed and is not marked late.

## Late Reasons

Late reasons are stored separately:

- `dropOffLateReason`
- `pickUpLateReason`

A student can have:

- No late reasons
- A late drop-off reason
- A late pick-up reason
- Both late drop-off and late pick-up reasons

Late reasons appear in the Print / Save PDF output. They do not appear in the main dashboard table.

If SMTP is configured, the app also emails the admin when a late reason is submitted.

## Automatic Report Emails

From the Admin Account page, staff can open **Sender Settings** to configure the one email account that sends reports. Staff can also open **Report Receivers** to add up to 12 receiver emails. The same receiver list gets daily and monthly reports.

Reports are sent automatically. Daily reports send once per day after the configured end-of-day hour, and monthly reports send the previous month's report on the first day of each month.

Automatic report emails include a plain text message and a PDF attachment. Reports include late labels and any late explanations saved on the attendance records.

## Print / Save PDF

From the admin dashboard, use:

```text
Print / Save PDF
```

The printed report includes the attendance table and a late reasons section when late reasons exist.

## Admin Account

Admins can manage their account at:

```text
http://localhost:3000/admin/account
```

The account page supports:

- Username changes
- Email changes
- Password changes

Default local admin:

```text
Username: admin
Password: admin123
```

## Quick Start

Open PowerShell in the project folder:

```powershell
cd C:\Users\Cesar\Documents\event-checkin\qr-checkin
```

Install dependencies:

```powershell
npm install
```

Start the server:

```powershell
npm start
```

Open:

```text
http://localhost:3000
```

## Files Of Interest

- `server.js`: Express server, attendance APIs, admin APIs, storage, email, and reminder logic.
- `public/index.html`: Parent drop-off and pick-up form.
- `public/script.js`: Parent form behavior, late-reason prompt, and success redirect.
- `public/checkin-success.html`: Confirmation page.
- `public/admin.html`: Admin dashboard markup.
- `public/admin.js`: Admin dashboard behavior, settings, export, print report.
- `public/admin-account.html`: Admin account page.
- `public/styles.css`: Shared styling.
- `public/school-logo.jpeg`: School logo used across the app.
- `data/attendance.csv`: Local CSV attendance storage.
- `data/admin.json`: Local admin profile and settings storage. Do not commit real production data.

## Persistent Data On Render

Render's normal filesystem can reset on redeploys and restarts. This app supports persistent storage.

Recommended Render persistent disk setup:

```text
DATA_DIR=/var/data
```

With that setting, the app stores:

```text
/var/data/attendance.csv
/var/data/admin.json
/var/data/users.csv
```

That preserves:

- Attendance records
- Drop-off and pick-up records
- Late reasons
- Late cutoff settings
- Admin account changes
- Report receivers
- Sender email settings
- Automatic daily and monthly report history

In Render, add a persistent disk and mount it at:

```text
/var/data
```

Then add this environment variable:

```text
DATA_DIR=/var/data
```

Without a persistent disk or Postgres database, Render can remove saved admin changes during a redeploy or restart.

The app also supports Postgres:

```text
DATABASE_URL=...
DATABASE_SSL=true
```

When `DATABASE_URL` is set, admin profile changes and attendance records are stored in Postgres. `DATA_DIR` is still used for local files such as `users.csv`.

## Environment Variables

Copy `.env.example` to `.env` for local development, or set the variables in Render.

Common settings:

```text
ADMIN_USER=admin
ADMIN_PASS=admin123
ADMIN_EMAIL=admin@example.com
REPORT_EMAIL=reports@example.com
DATA_DIR=/var/data
DATABASE_URL=
DATABASE_SSL=false
```

SMTP sender settings for email reminders, late reason emails, daily reports, and monthly reports:

```text
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=PrincetonReport@gmail.com
SMTP_PASS=your-sender-app-password
SMTP_FROM=Event Check-In <PrincetonReport@gmail.com>
SMTP_SECURE=false
SMTP_TIMEOUT_MS=10000
DAILY_REPORT_SEND_AFTER_HOUR=18
```

Use a dedicated sender email account for SMTP, not a personal email account. The sender account can be configured from **Admin Account** > **Sender Settings**. Report receiver emails are configured from **Admin Account** > **Report Receivers**.

If SMTP is not configured, attendance still works. The app logs that email was skipped.

## Data Format

CSV attendance records include:

- Student name
- Event date
- Drop-off parent name
- Drop-off time
- Drop-off timestamp
- Drop-off late reason
- Pick-up parent name
- Pick-up time
- Pick-up timestamp
- Pick-up late reason

Older CSV formats are still read and normalized by the server.

## Validation Commands

Use these checks after code changes:

```powershell
node --check server.js
node --check public\script.js
node --check public\admin.js
```

## Security Notes

- Local/demo admin passwords are stored in `admin.json`.
- For production, consider adding password hashing with bcrypt.
- Consider replacing client-stored Basic auth with server sessions or JWTs.
- Keep real `data/admin.json` and `data/attendance.csv` out of Git.

## Backup Notes

If using `DATA_DIR=/var/data`, back up the persistent disk data before bulk edits.

Important files:

```text
/var/data/attendance.csv
/var/data/admin.json
```

## Recent Feature Summary

This update added:

- Drop-off and pick-up actions
- One attendance session per student per event date
- Late cutoff settings
- Late labels
- Required late reasons
- Print / Save PDF late reason report
- Optional late reason admin emails
- Logo branding across pages
- Persistent storage compatibility for the new fields

---

Thank you for using Event Check-In.
