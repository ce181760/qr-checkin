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
const DEFAULT_LATE_DROP_OFF_AFTER = '08:36';
const DEFAULT_LATE_PICK_UP_AFTER = '13:35';
const dbPool = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
}) : null;
let adminTableReady = false;
let attendanceTableReady = false;

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
    fs.writeFileSync(csvFile, 'StudentName,EventDate,DropOffParentName,DropOffTime,DropOffTimestamp,DropOffLateReason,PickUpParentName,PickUpTime,PickUpTimestamp,PickUpLateReason\n', 'utf8');
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

function isValidTimeValue(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''));
}

function normalizeScheduleSettings(settings = {}) {
  const lateDropOffAfter = isValidTimeValue(settings.lateDropOffAfter || settings.late_drop_off_after)
    ? (settings.lateDropOffAfter || settings.late_drop_off_after)
    : DEFAULT_LATE_DROP_OFF_AFTER;
  const latePickUpAfter = isValidTimeValue(settings.latePickUpAfter || settings.late_pick_up_after)
    ? (settings.latePickUpAfter || settings.late_pick_up_after)
    : DEFAULT_LATE_PICK_UP_AFTER;

  return { lateDropOffAfter, latePickUpAfter };
}

function timeToMinutes(value) {
  if (!isValidTimeValue(value)) {
    return null;
  }

  const [hours, minutes] = value.split(':').map(Number);
  return (hours * 60) + minutes;
}

function timestampToLocalMinutes(timestamp) {
  const date = timestamp ? new Date(timestamp) : null;
  if (!date || Number.isNaN(date.getTime())) {
    return null;
  }

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ARRIVAL_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return (Number(values.hour) * 60) + Number(values.minute);
}

function getTimingFlags(record, scheduleSettings) {
  const settings = normalizeScheduleSettings(scheduleSettings);
  const flags = [];
  const dropOffMinutes = timestampToLocalMinutes(record.dropOffTimestamp || record.timestamp);
  const pickUpMinutes = timestampToLocalMinutes(record.pickUpTimestamp);
  const lateDropOffMinutes = timeToMinutes(settings.lateDropOffAfter);
  const latePickUpMinutes = timeToMinutes(settings.latePickUpAfter);

  if (dropOffMinutes !== null && lateDropOffMinutes !== null && dropOffMinutes >= lateDropOffMinutes) {
    flags.push('Late Drop-off');
  }

  if (pickUpMinutes !== null && latePickUpMinutes !== null && pickUpMinutes >= latePickUpMinutes) {
    flags.push('Late Pick-up');
  }

  return flags;
}

function getActionTimingStatus(action, timestamp, scheduleSettings) {
  const settings = normalizeScheduleSettings(scheduleSettings);
  const actionMinutes = timestampToLocalMinutes(timestamp);
  const cutoff = action === 'pick_up' ? settings.latePickUpAfter : settings.lateDropOffAfter;
  const cutoffMinutes = timeToMinutes(cutoff);

  if (actionMinutes !== null && cutoffMinutes !== null && actionMinutes >= cutoffMinutes) {
    return 'Late';
  }

  return 'On time';
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

async function ensureAttendanceTable() {
  if (!dbPool || attendanceTableReady) {
    return;
  }

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS attendance_records (
      id BIGSERIAL PRIMARY KEY,
      student_name TEXT NOT NULL,
      parent_name TEXT NOT NULL,
      arrival_date TEXT NOT NULL,
      arrival_time TEXT NOT NULL,
      timestamp TIMESTAMPTZ NOT NULL
    )
  `);
  await dbPool.query('ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS event_date TEXT');
  await dbPool.query('ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS drop_off_parent_name TEXT');
  await dbPool.query('ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS drop_off_time TEXT');
  await dbPool.query('ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS drop_off_timestamp TIMESTAMPTZ');
  await dbPool.query('ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS pick_up_parent_name TEXT');
  await dbPool.query('ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS pick_up_time TEXT');
  await dbPool.query('ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS pick_up_timestamp TIMESTAMPTZ');
  await dbPool.query('ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS drop_off_late_reason TEXT');
  await dbPool.query('ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS pick_up_late_reason TEXT');
  attendanceTableReady = true;
}

function normalizeAction(action) {
  return action === 'pick_up' ? 'pick_up' : 'drop_off';
}

function getSessionStatus(record) {
  if (record.pickUpTimestamp) {
    return 'Picked up';
  }

  if (record.dropOffTimestamp || record.timestamp) {
    return 'Present';
  }

  return 'Not arrived';
}

function normalizeRecord(record) {
  const dropOffTimestamp = record.dropOffTimestamp || record.timestamp || '';
  const dropOffDate = dropOffTimestamp ? new Date(dropOffTimestamp) : null;
  const eventDate = record.eventDate || record.arrivalDate || (dropOffDate && !Number.isNaN(dropOffDate.getTime()) ? formatArrivalDate(dropOffDate) : '');
  const dropOffTime = record.dropOffTime || record.arrivalTime || (dropOffDate && !Number.isNaN(dropOffDate.getTime()) ? formatArrivalTime(dropOffDate) : '');
  const dropOffParentName = record.dropOffParentName || record.parentName || '';

  const normalized = {
    studentName: record.studentName || '',
    eventDate,
    dropOffParentName,
    dropOffTime,
    dropOffTimestamp,
    dropOffLateReason: record.dropOffLateReason || '',
    pickUpParentName: record.pickUpParentName || '',
    pickUpTime: record.pickUpTime || '',
    pickUpTimestamp: record.pickUpTimestamp || '',
    pickUpLateReason: record.pickUpLateReason || '',
  };

  return {
    ...normalized,
    parentName: normalized.dropOffParentName,
    arrivalDate: normalized.eventDate,
    arrivalTime: normalized.dropOffTime,
    timestamp: normalized.dropOffTimestamp,
    status: getSessionStatus(normalized),
  };
}

function findSessionIndex(records, studentName, eventDate) {
  const normalizedStudentName = studentName.toLowerCase();
  return records.findIndex((record) => (
    record.studentName.toLowerCase() === normalizedStudentName
    && record.eventDate === eventDate
  ));
}

async function recordAttendanceAction(studentName, parentName, action, lateReason = '') {
  const attendanceAction = normalizeAction(action);
  const actionAt = new Date();
  const timestamp = actionAt.toISOString();
  const eventDate = formatArrivalDate(actionAt);
  const actionTime = formatArrivalTime(actionAt);
  const profile = await readAdminProfile();
  const timingStatus = getActionTimingStatus(attendanceAction, timestamp, profile.scheduleSettings);
  const trimmedLateReason = String(lateReason || '').trim();

  if (timingStatus === 'Late' && !trimmedLateReason) {
    const actionLabel = attendanceAction === 'pick_up' ? 'pick-up' : 'drop-off';
    const error = new Error(`Please enter a reason for the late ${actionLabel}.`);
    error.requiresLateReason = true;
    error.timingStatus = timingStatus;
    error.action = attendanceAction;
    error.actionTime = actionTime;
    throw error;
  }

  if (dbPool) {
    await ensureAttendanceTable();
    const existing = await dbPool.query(`
      SELECT id,
        COALESCE(drop_off_timestamp, timestamp) AS drop_off_timestamp,
        pick_up_timestamp
      FROM attendance_records
      WHERE LOWER(student_name) = LOWER($1)
        AND COALESCE(event_date, arrival_date) = $2
      ORDER BY id ASC
      LIMIT 1
    `, [studentName, eventDate]);

    if (attendanceAction === 'drop_off') {
      if (existing.rows[0]?.drop_off_timestamp) {
        throw new Error('This student has already been dropped off today.');
      }

      if (existing.rows.length) {
        await dbPool.query(`
          UPDATE attendance_records
          SET parent_name = $1,
              arrival_date = $2,
              arrival_time = $3,
              timestamp = $4,
              event_date = $2,
              drop_off_parent_name = $1,
              drop_off_time = $3,
              drop_off_timestamp = $4,
              drop_off_late_reason = $5
          WHERE id = $6
        `, [parentName, eventDate, actionTime, timestamp, trimmedLateReason, existing.rows[0].id]);
      } else {
        await dbPool.query(`
          INSERT INTO attendance_records (
            student_name, parent_name, arrival_date, arrival_time, timestamp,
            event_date, drop_off_parent_name, drop_off_time, drop_off_timestamp,
            drop_off_late_reason
          )
          VALUES ($1, $2, $3, $4, $5, $3, $2, $4, $5, $6)
        `, [studentName, parentName, eventDate, actionTime, timestamp, trimmedLateReason]);
      }
    } else {
      if (!existing.rows.length || !existing.rows[0].drop_off_timestamp) {
        throw new Error('This student must be dropped off before they can be picked up.');
      }

      if (existing.rows[0].pick_up_timestamp) {
        throw new Error('This student has already been picked up today.');
      }

      await dbPool.query(`
        UPDATE attendance_records
        SET event_date = COALESCE(event_date, arrival_date),
            pick_up_parent_name = $1,
            pick_up_time = $2,
            pick_up_timestamp = $3,
            pick_up_late_reason = $4
        WHERE id = $5
      `, [parentName, actionTime, timestamp, trimmedLateReason, existing.rows[0].id]);
    }

    if (timingStatus === 'Late') {
      await trySendLateAttendanceEmail({
        studentName,
        parentName,
        action: attendanceAction,
        actionTime,
        eventDate,
        lateReason: trimmedLateReason,
        profile,
      });
    }

    return { action: attendanceAction, eventDate, actionTime, timestamp, timingStatus };
  }

  ensureAttendanceFile();
  const records = await readRecords();
  const sessionIndex = findSessionIndex(records, studentName, eventDate);
  const session = sessionIndex >= 0 ? records[sessionIndex] : null;

  if (attendanceAction === 'drop_off') {
    if (session?.dropOffTimestamp) {
      throw new Error('This student has already been dropped off today.');
    }

    const nextSession = normalizeRecord({
      studentName,
      eventDate,
      dropOffParentName: parentName,
      dropOffTime: actionTime,
      dropOffTimestamp: timestamp,
      dropOffLateReason: trimmedLateReason,
      pickUpParentName: session?.pickUpParentName,
      pickUpTime: session?.pickUpTime,
      pickUpTimestamp: session?.pickUpTimestamp,
      pickUpLateReason: session?.pickUpLateReason,
    });

    if (sessionIndex >= 0) {
      records[sessionIndex] = nextSession;
    } else {
      records.push(nextSession);
    }
  } else {
    if (!session?.dropOffTimestamp) {
      throw new Error('This student must be dropped off before they can be picked up.');
    }

    if (session.pickUpTimestamp) {
      throw new Error('This student has already been picked up today.');
    }

    records[sessionIndex] = normalizeRecord({
      ...session,
      pickUpParentName: parentName,
      pickUpTime: actionTime,
      pickUpTimestamp: timestamp,
      pickUpLateReason: trimmedLateReason,
    });
  }

  writeRecords(records);
  if (timingStatus === 'Late') {
    await trySendLateAttendanceEmail({
      studentName,
      parentName,
      action: attendanceAction,
      actionTime,
      eventDate,
      lateReason: trimmedLateReason,
      profile,
    });
  }
  return { action: attendanceAction, eventDate, actionTime, timestamp, timingStatus };
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

app.post('/checkin', async (req, res) => {
  const studentName = (req.body.studentName || '').trim();
  const parentName = (req.body.parentName || '').trim();
  const action = normalizeAction(req.body.action);
  const lateReason = (req.body.lateReason || '').trim();
  if (!studentName || !parentName) {
    return res.status(400).json({ error: 'Student name and parent name are required' });
  }

  try {
    const attendance = await recordAttendanceAction(studentName, parentName, action, lateReason);
    return res.json({ success: true, studentName, parentName, ...attendance });
  } catch (error) {
    if (error.requiresLateReason) {
      return res.status(409).json({
        error: error.message,
        requiresLateReason: true,
        action: error.action,
        actionTime: error.actionTime,
        timingStatus: error.timingStatus,
      });
    }
    return res.status(400).json({ error: error.message || 'Unable to save attendance' });
  }
});

app.get('/attendance', async (req, res) => {
  res.json(await readRecords());
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
    scheduleSettings: normalizeScheduleSettings(),
  };
}

function normalizeAdminProfile(profile) {
  return {
    username: profile.username || ADMIN_USER,
    password: profile.password || ADMIN_PASS,
    email: profile.email || ADMIN_EMAIL,
    lastPasswordChange: profile.lastPasswordChange || profile.last_password_change || profile.lastPasswordReminder || new Date().toISOString(),
    lastReminderSent: profile.lastReminderSent || profile.last_reminder_sent || profile.lastPasswordReminder || null,
    scheduleSettings: normalizeScheduleSettings({
      lateDropOffAfter: profile.lateDropOffAfter,
      latePickUpAfter: profile.latePickUpAfter,
      late_drop_off_after: profile.late_drop_off_after,
      late_pick_up_after: profile.late_pick_up_after,
      ...(profile.scheduleSettings || {}),
    }),
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
      last_reminder_sent TIMESTAMPTZ,
      late_drop_off_after TEXT,
      late_pick_up_after TEXT
    )
  `);
  await dbPool.query('ALTER TABLE admin_profile ADD COLUMN IF NOT EXISTS late_drop_off_after TEXT');
  await dbPool.query('ALTER TABLE admin_profile ADD COLUMN IF NOT EXISTS late_pick_up_after TEXT');
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
      INSERT INTO admin_profile (
        id, username, password, email, last_password_change, last_reminder_sent,
        late_drop_off_after, late_pick_up_after
      )
      VALUES (1, $1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (id) DO UPDATE SET
        username = EXCLUDED.username,
        password = EXCLUDED.password,
        email = EXCLUDED.email,
        last_password_change = EXCLUDED.last_password_change,
        last_reminder_sent = EXCLUDED.last_reminder_sent,
        late_drop_off_after = EXCLUDED.late_drop_off_after,
        late_pick_up_after = EXCLUDED.late_pick_up_after
    `, [
      profile.username,
      profile.password,
      profile.email,
      profile.lastPasswordChange || new Date().toISOString(),
      profile.lastReminderSent || null,
      normalizeScheduleSettings(profile.scheduleSettings).lateDropOffAfter,
      normalizeScheduleSettings(profile.scheduleSettings).latePickUpAfter,
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

async function sendLateAttendanceEmail(details) {
  const transporter = getMailTransport();
  if (!transporter) {
    console.log('SMTP not configured. Late attendance email not sent.');
    return false;
  }

  const actionLabel = details.action === 'pick_up' ? 'Late pick-up' : 'Late drop-off';
  const text = [
    actionLabel,
    '',
    `Student: ${details.studentName}`,
    `Parent: ${details.parentName}`,
    `Date: ${details.eventDate}`,
    `Time: ${details.actionTime}`,
    `Reason: ${details.lateReason}`,
  ].join('\n');

  await transporter.sendMail({
    from: SMTP_FROM,
    to: details.profile.email,
    subject: `${actionLabel}: ${details.studentName}`,
    text,
  });

  return true;
}

async function trySendLateAttendanceEmail(details) {
  try {
    await sendLateAttendanceEmail(details);
  } catch (error) {
    console.error('Failed to send late attendance email:', error.message || error);
  }
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

async function readRecords() {
  const profile = await readAdminProfile();
  const scheduleSettings = profile.scheduleSettings;

  if (dbPool) {
    await ensureAttendanceTable();
    const result = await dbPool.query(`
      SELECT student_name, parent_name, arrival_date, arrival_time, timestamp,
        event_date, drop_off_parent_name, drop_off_time, drop_off_timestamp,
        drop_off_late_reason, pick_up_parent_name, pick_up_time, pick_up_timestamp,
        pick_up_late_reason
      FROM attendance_records
      ORDER BY timestamp ASC, id ASC
    `);
    return result.rows.map((record) => {
      const normalized = normalizeRecord({
      studentName: record.student_name,
      parentName: record.parent_name,
      arrivalDate: record.arrival_date,
      arrivalTime: record.arrival_time,
      timestamp: new Date(record.timestamp).toISOString(),
      eventDate: record.event_date,
      dropOffParentName: record.drop_off_parent_name,
      dropOffTime: record.drop_off_time,
      dropOffTimestamp: record.drop_off_timestamp ? new Date(record.drop_off_timestamp).toISOString() : '',
      dropOffLateReason: record.drop_off_late_reason,
      pickUpParentName: record.pick_up_parent_name,
      pickUpTime: record.pick_up_time,
      pickUpTimestamp: record.pick_up_timestamp ? new Date(record.pick_up_timestamp).toISOString() : '',
      pickUpLateReason: record.pick_up_late_reason,
      });
      return {
        ...normalized,
        timingFlags: getTimingFlags(normalized, scheduleSettings),
      };
    });
  }

  ensureAttendanceFile();
  const csv = fs.readFileSync(csvFile, 'utf8');

  return csv.split('\n').filter(Boolean).slice(1).map((line) => {
    const values = parseCsvLine(line);
    let record = null;
    if (values.length === 3) {
      const timestamp = values[2];
      const date = timestamp ? new Date(timestamp) : null;
      record = normalizeRecord({
        studentName: values[0],
        parentName: values[1],
        arrivalDate: date && !Number.isNaN(date.getTime()) ? formatArrivalDate(date) : '',
        arrivalTime: date && !Number.isNaN(date.getTime()) ? formatArrivalTime(date) : '',
        timestamp,
      });
    } else if (values.length === 5) {
      record = normalizeRecord({
        studentName: values[0],
        parentName: values[1],
        arrivalDate: values[2],
        arrivalTime: values[3],
        timestamp: values[4],
      });
    } else if (values.length === 8) {
      record = normalizeRecord({
        studentName: values[0],
        eventDate: values[1],
        dropOffParentName: values[2],
        dropOffTime: values[3],
        dropOffTimestamp: values[4],
        pickUpParentName: values[5],
        pickUpTime: values[6],
        pickUpTimestamp: values[7],
      });
    } else if (values.length === 10) {
      record = normalizeRecord({
        studentName: values[0],
        eventDate: values[1],
        dropOffParentName: values[2],
        dropOffTime: values[3],
        dropOffTimestamp: values[4],
        dropOffLateReason: values[5],
        pickUpParentName: values[6],
        pickUpTime: values[7],
        pickUpTimestamp: values[8],
        pickUpLateReason: values[9],
      });
    } else if (values.length >= 6) {
      record = normalizeRecord({
        studentName: values[0],
        parentName: values[1],
        arrivalDate: values[3],
        arrivalTime: values[4],
        timestamp: values[5],
      });
    }

    if (!record) return null;
    return {
      ...record,
      timingFlags: getTimingFlags(record, scheduleSettings),
    };
  }).filter(Boolean);
}

function writeRecords(records) {
  ensureAttendanceFile();
  const csvLines = [
    'StudentName,EventDate,DropOffParentName,DropOffTime,DropOffTimestamp,DropOffLateReason,PickUpParentName,PickUpTime,PickUpTimestamp,PickUpLateReason',
    ...records.map((record) => {
      const normalized = normalizeRecord(record);
      return [
        normalized.studentName,
        normalized.eventDate,
        normalized.dropOffParentName,
        normalized.dropOffTime,
        normalized.dropOffTimestamp,
        normalized.dropOffLateReason,
        normalized.pickUpParentName,
        normalized.pickUpTime,
        normalized.pickUpTimestamp,
        normalized.pickUpLateReason,
      ].map((value) => `"${escapeCsv(value)}"`).join(',');
    }),
  ];
  fs.writeFileSync(csvFile, csvLines.join('\n') + '\n', 'utf8');
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
    scheduleSettings: currentProfile.scheduleSettings,
  };
  await writeAdminProfile(profile);
  return res.json({ username: profile.username, email: profile.email, passwordChangeRequired: false });
});

app.get('/api/admin/schedule-settings', basicAuth, async (req, res) => {
  const profile = await readAdminProfile();
  res.json(profile.scheduleSettings);
});

app.post('/api/admin/schedule-settings', basicAuth, async (req, res) => {
  const scheduleSettings = normalizeScheduleSettings(req.body);
  if (!isValidTimeValue(req.body.lateDropOffAfter) || !isValidTimeValue(req.body.latePickUpAfter)) {
    return res.status(400).json({ error: 'Late drop-off and late pick-up times must use HH:MM format.' });
  }

  const profile = await readAdminProfile();
  await writeAdminProfile({
    ...profile,
    scheduleSettings,
  });

  res.json(scheduleSettings);
});

app.get('/api/records', basicAuth, async (req, res) => {
  res.json(await readRecords());
});

app.delete('/api/records', basicAuth, async (req, res) => {
  const { studentName, eventDate, dropOffTimestamp, timestamp } = req.body;
  const recordTimestamp = dropOffTimestamp || timestamp;
  if (!studentName || !eventDate || !recordTimestamp) {
    return res.status(400).send('Student name, event date, and drop-off timestamp are required');
  }

  if (dbPool) {
    await ensureAttendanceTable();
    const result = await dbPool.query(`
      DELETE FROM attendance_records
      WHERE id = (
        SELECT id FROM attendance_records
        WHERE student_name = $1
          AND COALESCE(event_date, arrival_date) = $2
          AND COALESCE(drop_off_timestamp, timestamp) = $3
        ORDER BY id ASC
        LIMIT 1
      )
      RETURNING id
    `, [studentName, eventDate, recordTimestamp]);

    if (!result.rowCount) {
      return res.status(404).send('Record not found');
    }

    return res.json({ deleted: true });
  }

  const records = await readRecords();
  const remaining = records.filter((record) => !(
    record.studentName === studentName
    && record.eventDate === eventDate
    && record.dropOffTimestamp === recordTimestamp
  ));
  if (remaining.length === records.length) {
    return res.status(404).send('Record not found');
  }

  writeRecords(remaining);
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
