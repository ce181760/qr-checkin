const express = require('express');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const csvFile = path.join(DATA_DIR, 'attendance.csv');
const usersFile = path.join(DATA_DIR, 'users.csv');
const adminFile = path.join(DATA_DIR, 'admin.json');
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const DATABASE_URL = process.env.DATABASE_URL || '';
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = parseInt(process.env.SMTP_PORT, 10) || 587;
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || `no-reply@${process.env.SMTP_HOST || 'localhost'}`;
const SMTP_SECURE = process.env.SMTP_SECURE === 'true';
const ARRIVAL_TIME_ZONE = 'America/New_York';
const dbPool = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
}) : null;
let adminTableReady = false;

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function ensureUsersFile() {
  ensureDir();
  if (!fs.existsSync(usersFile)) {
    fs.writeFileSync(usersFile, 'FirstName,LastName,Phone,Email\n', 'utf8');
  }
}

function ensureAttendanceFile() {
  ensureDir();
  if (!fs.existsSync(csvFile)) {
    fs.writeFileSync(csvFile, 'StudentName,ParentName,ArrivalDate,ArrivalTime,Timestamp\n', 'utf8');
  }
}

function escapeCsv(value) {
  return String(value || '').replace(/"/g, '""');
}

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const nextChar = line[index + 1];

    if (char === '"' && inQuotes && nextChar === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      values.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  values.push(current);
  return values;
}

function formatArrivalDate(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ARRIVAL_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function formatArrivalTime(date) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: ARRIVAL_TIME_ZONE,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

function userExists(firstName, lastName) {
  ensureUsersFile();
  const csv = fs.readFileSync(usersFile, 'utf8');
  const lines = csv.split('\n').filter(Boolean).slice(1);
  return lines.some((line) => {
    const match = line.match(/^"((?:[^"]|"")*)","((?:[^"]|"")*)"(?:,"[^"]*","[^"]*")?$/);
    if (!match) return false;
    const fName = match[1].replace(/""/g, '"');
    const lName = match[2].replace(/""/g, '"');
    return fName === firstName && lName === lastName;
  });
}

function addUser(firstName, lastName, phone, email) {
  ensureUsersFile();
  const line = `"${escapeCsv(firstName)}","${escapeCsv(lastName)}","${escapeCsv(phone)}","${escapeCsv(email)}"\n`;
  fs.appendFileSync(usersFile, line, 'utf8');
}

function recordCheckin(studentName, parentName) {
  ensureAttendanceFile();
  const arrivedAt = new Date();
  const timestamp = arrivedAt.toISOString();
  const arrivalDate = formatArrivalDate(arrivedAt);
  const arrivalTime = formatArrivalTime(arrivedAt);
  const line = `"${escapeCsv(studentName)}","${escapeCsv(parentName)}","${arrivalDate}","${arrivalTime}","${timestamp}"\n`;
  fs.appendFileSync(csvFile, line, 'utf8');
  return { arrivalDate, arrivalTime, timestamp };
}

async function basicAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Admin Area"');
    return res.status(401).send('Authentication required');
  }

  const credentials = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
  const [user, pass] = credentials.split(':');
  const profile = await readAdminProfile();

  if (user === profile.username && pass === profile.password) {
    return next();
  }

  return res.status(403).send('Forbidden');
}

app.post('/checkin', (req, res) => {
  const studentName = (req.body.studentName || '').trim();
  const parentName = (req.body.parentName || '').trim();
  if (!studentName || !parentName) {
    return res.status(400).json({ error: 'Student name and parent name are required' });
  }

  const arrival = recordCheckin(studentName, parentName);
  return res.json({ success: true, studentName, parentName, ...arrival });
});

app.get('/attendance', (req, res) => {
  res.json(readRecords());
});

app.post('/register', (req, res) => {
  const { firstName, lastName, phone, email } = req.body;
  if (!firstName || !lastName || !phone || !email) {
    return res.status(400).json({ error: 'All fields required' });
  }

  addUser(firstName, lastName, phone, email);
  res.json({ success: true });
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/admin/account', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-account.html'));
});

function ensureAdminFile() {
  ensureDir();
  if (!fs.existsSync(adminFile)) {
    const defaultProfile = getDefaultAdminProfile();
    fs.writeFileSync(adminFile, JSON.stringify(defaultProfile, null, 2) + '\n', 'utf8');
  }
}

function getDefaultAdminProfile() {
  return {
    username: ADMIN_USER,
    password: ADMIN_PASS,
    email: ADMIN_EMAIL,
    lastPasswordChange: new Date().toISOString(),
    lastReminderSent: null,
  };
}

function normalizeAdminProfile(profile) {
  return {
    username: profile.username || ADMIN_USER,
    password: profile.password || ADMIN_PASS,
    email: profile.email || ADMIN_EMAIL,
    lastPasswordChange: profile.lastPasswordChange || profile.last_password_change || profile.lastPasswordReminder || new Date().toISOString(),
    lastReminderSent: profile.lastReminderSent || profile.last_reminder_sent || profile.lastPasswordReminder || null,
  };
}

async function ensureAdminTable() {
  if (!dbPool || adminTableReady) {
    return;
  }

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS admin_profile (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      email TEXT NOT NULL,
      last_password_change TIMESTAMPTZ NOT NULL,
      last_reminder_sent TIMESTAMPTZ
    )
  `);
  adminTableReady = true;
}

async function readAdminProfile() {
  if (dbPool) {
    await ensureAdminTable();
    const result = await dbPool.query('SELECT * FROM admin_profile WHERE id = 1');
    if (result.rows.length) {
      return normalizeAdminProfile(result.rows[0]);
    }

    const defaultProfile = getDefaultAdminProfile();
    await writeAdminProfile(defaultProfile);
    return defaultProfile;
  }

  ensureAdminFile();

  try {
    const json = fs.readFileSync(adminFile, 'utf8');
    const profile = JSON.parse(json);

    return normalizeAdminProfile(profile);
  } catch (error) {
    const defaultProfile = getDefaultAdminProfile();
    fs.writeFileSync(adminFile, JSON.stringify(defaultProfile, null, 2) + '\n', 'utf8');
    return defaultProfile;
  }
}

async function writeAdminProfile(profile) {
  if (dbPool) {
    await ensureAdminTable();
    await dbPool.query(`
      INSERT INTO admin_profile (id, username, password, email, last_password_change, last_reminder_sent)
      VALUES (1, $1, $2, $3, $4, $5)
      ON CONFLICT (id) DO UPDATE SET
        username = EXCLUDED.username,
        password = EXCLUDED.password,
        email = EXCLUDED.email,
        last_password_change = EXCLUDED.last_password_change,
        last_reminder_sent = EXCLUDED.last_reminder_sent
    `, [
      profile.username,
      profile.password,
      profile.email,
      profile.lastPasswordChange || new Date().toISOString(),
      profile.lastReminderSent || null,
    ]);
    return;
  }

  ensureAdminFile();
  fs.writeFileSync(adminFile, JSON.stringify(profile, null, 2) + '\n', 'utf8');
}

function isPasswordChangeRequired(profile) {
  if (!profile.lastReminderSent) {
    return false;
  }

  const lastChange = profile.lastPasswordChange ? new Date(profile.lastPasswordChange) : null;
  const lastReminder = new Date(profile.lastReminderSent);
  return !lastChange || lastChange.getTime() < lastReminder.getTime();
}

function isReminderDue(profile) {
  const lastChange = profile.lastPasswordChange ? new Date(profile.lastPasswordChange) : null;
  const lastReminder = profile.lastReminderSent ? new Date(profile.lastReminderSent) : null;
  const latest = lastChange && lastReminder ? new Date(Math.max(lastChange.getTime(), lastReminder.getTime())) : (lastChange || lastReminder);

  if (!latest) {
    return true;
  }

  return (Date.now() - latest.getTime()) >= 30 * 24 * 60 * 60 * 1000;
}

function getMailTransport() {
  if (!SMTP_HOST) {
    return null;
  }

  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  });
}

async function sendPasswordReminder(profile) {
  const transporter = getMailTransport();
  const subject = 'Admin password reminder';
  const text = `Hello ${profile.username},\n\nThis is a reminder to change your admin password. It has been one month since the last reminder.\n\nIf you have already changed your password, you can ignore this message.\n\nThanks.`;

  if (!transporter) {
    console.log('SMTP not configured. Password reminder email not sent.');
    return false;
  }

  await transporter.sendMail({
    from: SMTP_FROM,
    to: profile.email,
    subject,
    text,
  });

  return true;
}

async function checkAndSendPasswordReminder() {
  const profile = await readAdminProfile();
  const reminderDue = isReminderDue(profile);

  if (!reminderDue) {
    return;
  }

  try {
    const sent = await sendPasswordReminder(profile);
    if (sent) {
      profile.lastReminderSent = new Date().toISOString();
      await writeAdminProfile(profile);
      console.log(`Password reminder sent to ${profile.email}`);
    }
  } catch (error) {
    console.error('Failed to send password reminder:', error.message || error);
  }
}

function readUsers() {
  ensureUsersFile();
  const csv = fs.readFileSync(usersFile, 'utf8');
  return csv.split('\n').filter(Boolean).slice(1).map((line) => {
    const match = line.match(/^"((?:[^"]|"")*)","((?:[^"]|"")*)","([^"]*)","([^"]*)"$/);
    if (!match) return null;
    return {
      firstName: match[1].replace(/""/g, '"'),
      lastName: match[2].replace(/""/g, '"'),
      phone: match[3],
      email: match[4],
    };
  }).filter(Boolean);
}

function readRecords() {
  ensureAttendanceFile();
  const csv = fs.readFileSync(csvFile, 'utf8');

  return csv.split('\n').filter(Boolean).slice(1).map((line) => {
    const values = parseCsvLine(line);
    if (values.length === 3) {
      const timestamp = values[2];
      const date = timestamp ? new Date(timestamp) : null;
      return {
        studentName: values[0],
        parentName: values[1],
        arrivalDate: date && !Number.isNaN(date.getTime()) ? formatArrivalDate(date) : '',
        arrivalTime: date && !Number.isNaN(date.getTime()) ? formatArrivalTime(date) : '',
        timestamp,
      };
    }

    if (values.length === 5) {
      return {
        studentName: values[0],
        parentName: values[1],
        arrivalDate: values[2],
        arrivalTime: values[3],
        timestamp: values[4],
      };
    }

    if (values.length < 6) return null;
    return {
      studentName: values[0],
      parentName: values[1],
      arrivalDate: values[3],
      arrivalTime: values[4],
      timestamp: values[5],
    };
  }).filter(Boolean);
}

app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const profile = await readAdminProfile();
  if (username === profile.username && password === profile.password) {
    return res.json({ username: profile.username, email: profile.email, passwordChangeRequired: isPasswordChangeRequired(profile) });
  }

  return res.status(403).json({ error: 'Invalid username or password' });
});

app.get('/api/admin/profile', basicAuth, async (req, res) => {
  const profile = await readAdminProfile();
  res.json({ username: profile.username, email: profile.email, passwordChangeRequired: isPasswordChangeRequired(profile) });
});

app.post('/api/admin/profile', basicAuth, async (req, res) => {
  const { username, password, email } = req.body;
  if (!username || !password || !email) {
    return res.status(400).json({ error: 'Username, password, and email are required' });
  }

  const currentProfile = await readAdminProfile();
  if (password === currentProfile.password) {
    return res.status(400).json({ error: 'New password must be different from the current password' });
  }

  const profile = {
    username,
    password,
    email,
    lastPasswordChange: new Date().toISOString(),
    lastReminderSent: currentProfile.lastReminderSent || null,
  };
  await writeAdminProfile(profile);
  return res.json({ username: profile.username, email: profile.email, passwordChangeRequired: false });
});

app.get('/api/records', basicAuth, (req, res) => {
  res.json(readRecords());
});

app.delete('/api/records', basicAuth, (req, res) => {
  const { studentName, parentName, timestamp } = req.body;
  if (!studentName || !parentName || !timestamp) {
    return res.status(400).send('Student name, parent name, and timestamp are required');
  }

  const records = readRecords();
  const remaining = records.filter((record) => !(record.studentName === studentName && record.parentName === parentName && record.timestamp === timestamp));
  if (remaining.length === records.length) {
    return res.status(404).send('Record not found');
  }

  const csvLines = [
    'StudentName,ParentName,ArrivalDate,ArrivalTime,Timestamp',
    ...remaining.map((record) => `"${escapeCsv(record.studentName)}","${escapeCsv(record.parentName)}","${escapeCsv(record.arrivalDate)}","${escapeCsv(record.arrivalTime)}","${escapeCsv(record.timestamp)}"`),
  ];
  fs.writeFileSync(csvFile, csvLines.join('\n') + '\n', 'utf8');
  res.json({ deleted: true });
});

app.listen(PORT, async () => {
  const profile = await readAdminProfile();
  console.log(`Event check-in app running at http://localhost:${PORT}`);
  console.log(`Admin page: http://localhost:${PORT}/admin`);
  console.log(`Admin username: ${profile.username}`);
  console.log(`Admin storage: ${dbPool ? 'database' : adminFile}`);

  await checkAndSendPasswordReminder();
  setInterval(checkAndSendPasswordReminder, 24 * 60 * 60 * 1000);
});
