const express = require('express');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;
const csvFile = path.join(__dirname, 'data', 'attendance.csv');
const usersFile = path.join(__dirname, 'data', 'users.csv');
const adminFile = path.join(__dirname, 'data', 'admin.json');
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = parseInt(process.env.SMTP_PORT, 10) || 587;
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || `no-reply@${process.env.SMTP_HOST || 'localhost'}`;
const SMTP_SECURE = process.env.SMTP_SECURE === 'true';

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function ensureDir() {
  if (!fs.existsSync(path.dirname(usersFile))) {
    fs.mkdirSync(path.dirname(usersFile), { recursive: true });
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
    fs.writeFileSync(csvFile, 'StudentName,ParentName,Timestamp\n', 'utf8');
  }
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
  const line = `"${firstName.replace(/"/g, '""')}","${lastName.replace(/"/g, '""')}","${phone}","${email}"\n`;
  fs.appendFileSync(usersFile, line, 'utf8');
}

function recordCheckin(studentName, parentName) {
  ensureAttendanceFile();
  const timestamp = new Date().toISOString();
  const line = `"${studentName.replace(/"/g, '""')}","${parentName.replace(/"/g, '""')}","${timestamp}"\n`;
  fs.appendFileSync(csvFile, line, 'utf8');
}

function basicAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Admin Area"');
    return res.status(401).send('Authentication required');
  }

  const credentials = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
  const [user, pass] = credentials.split(':');
  const profile = readAdminProfile();

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

  recordCheckin(studentName, parentName);
  return res.json({ success: true, studentName, parentName, timestamp: new Date().toISOString() });
});

app.get('/attendance', (req, res) => {
  ensureAttendanceFile();
  const csv = fs.readFileSync(csvFile, 'utf8');
  const records = csv.split('\n').filter(Boolean).slice(1).map((line) => {
    const match = line.match(/^"((?:[^"]|"")*)","((?:[^"]|"")*)","([^"]+)"$/);
    if (!match) return null;
    return {
      studentName: match[1].replace(/""/g, '"'),
      parentName: match[2].replace(/""/g, '"'),
      timestamp: match[3],
    };
  }).filter(Boolean);
  res.json(records);
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
    const defaultProfile = {
      username: ADMIN_USER,
      password: ADMIN_PASS,
      email: ADMIN_EMAIL,
      lastPasswordChange: new Date().toISOString(),
      lastReminderSent: null,
    };
    fs.writeFileSync(adminFile, JSON.stringify(defaultProfile, null, 2) + '\n', 'utf8');
  }
}

function readAdminProfile() {
  ensureAdminFile();

  try {
    const json = fs.readFileSync(adminFile, 'utf8');
    const profile = JSON.parse(json);

    return {
      username: profile.username || ADMIN_USER,
      password: profile.password || ADMIN_PASS,
      email: profile.email || ADMIN_EMAIL,
      lastPasswordChange: profile.lastPasswordChange || profile.lastPasswordReminder || new Date().toISOString(),
      lastReminderSent: profile.lastReminderSent || profile.lastPasswordReminder || null,
    };
  } catch (error) {
    const defaultProfile = {
      username: ADMIN_USER,
      password: ADMIN_PASS,
      email: ADMIN_EMAIL,
      lastPasswordChange: new Date().toISOString(),
      lastReminderSent: null,
    };
    fs.writeFileSync(adminFile, JSON.stringify(defaultProfile, null, 2) + '\n', 'utf8');
    return defaultProfile;
  }
}

function writeAdminProfile(profile) {
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
  const profile = readAdminProfile();
  const reminderDue = isReminderDue(profile);

  if (!reminderDue) {
    return;
  }

  try {
    const sent = await sendPasswordReminder(profile);
    if (sent) {
      profile.lastReminderSent = new Date().toISOString();
      writeAdminProfile(profile);
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
    const match = line.match(/^"((?:[^"]|"")*)","((?:[^"]|"")*)","([^"]+)"$/);
    if (!match) return null;
    return {
      studentName: match[1].replace(/""/g, '"'),
      parentName: match[2].replace(/""/g, '"'),
      timestamp: match[3],
    };
  }).filter(Boolean);
}

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const profile = readAdminProfile();
  if (username === profile.username && password === profile.password) {
    return res.json({ username: profile.username, email: profile.email, passwordChangeRequired: isPasswordChangeRequired(profile) });
  }

  return res.status(403).json({ error: 'Invalid username or password' });
});

app.get('/api/admin/profile', basicAuth, (req, res) => {
  const profile = readAdminProfile();
  res.json({ username: profile.username, email: profile.email, passwordChangeRequired: isPasswordChangeRequired(profile) });
});

app.post('/api/admin/profile', basicAuth, (req, res) => {
  const { username, password, email } = req.body;
  if (!username || !password || !email) {
    return res.status(400).json({ error: 'Username, password, and email are required' });
  }

  const currentProfile = readAdminProfile();
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
  writeAdminProfile(profile);
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

  const csvLines = ['StudentName,ParentName,Timestamp', ...remaining.map((record) => `"${record.studentName.replace(/"/g, '""')}","${record.parentName.replace(/"/g, '""')}","${record.timestamp}"`)];
  fs.writeFileSync(csvFile, csvLines.join('\n') + '\n', 'utf8');
  res.json({ deleted: true });
});

app.listen(PORT, async () => {
  console.log(`Event check-in app running at http://localhost:${PORT}`);
  console.log(`Admin page: http://localhost:${PORT}/admin`);
  console.log(`Username: ${ADMIN_USER}`);
  console.log(`Password: ${ADMIN_PASS}`);

  await checkAndSendPasswordReminder();
  setInterval(checkAndSendPasswordReminder, 24 * 60 * 60 * 1000);
});
