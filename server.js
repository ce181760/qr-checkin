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
const receiptDir = path.join(DATA_DIR, 'late-pickup-receipts');
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
const DEFAULT_LATE_PAYMENT_METHOD = 'venmo';
const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;
const RECEIPT_MIME_EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};
const dbPool = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
}) : null;
let attendanceTableReady = false;

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function ensureReceiptDir() {
  ensureDir();
  if (!fs.existsSync(receiptDir)) {
    fs.mkdirSync(receiptDir, { recursive: true });
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
  await dbPool.query('ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS pick_up_late_payment_confirmed BOOLEAN DEFAULT FALSE');
  await dbPool.query('ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS pick_up_late_payment_receipt TEXT');
  await dbPool.query('ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS pick_up_late_payment_method TEXT DEFAULT \'venmo\'');
  await dbPool.query('ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS pick_up_late_payment_approved BOOLEAN DEFAULT FALSE');
  await dbPool.query('ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS pick_up_late_payment_admin_signature TEXT');
  attendanceTableReady = true;
}

function normalizeAction(action) {
  return action === 'pick_up' ? 'pick_up' : 'drop_off';
}

function getStudentCheckInRequiredMessage() {
  return 'Pick-up can only be saved after the student has checked in today.';
}

function canRecordPickup(existingRecord = {}) {
  if (!existingRecord || typeof existingRecord !== 'object') {
    return true;
  }

  if (existingRecord.pickUpTimestamp) {
    return false;
  }

  return true;
}

function resolveAttendanceAction(requestedAction, existingRecord = null) {
  const normalizedAction = normalizeAction(requestedAction);
  if (normalizedAction !== 'drop_off' || !existingRecord || typeof existingRecord !== 'object') {
    return normalizedAction;
  }

  const hasDropOff = Boolean(existingRecord.drop_off_timestamp || existingRecord.dropOffTimestamp || existingRecord.timestamp);
  const hasPickUp = Boolean(existingRecord.pick_up_timestamp || existingRecord.pickUpTimestamp);

  if (hasDropOff && !hasPickUp) {
    return 'pick_up';
  }

  return normalizedAction;
}

function normalizeBoolean(value) {
  return value === true || value === 'true' || value === 'on' || value === 1 || value === '1';
}

function normalizePaymentMethod(value) {
  const method = String(value || '').trim().toLowerCase();
  if (method === 'cash') {
    return 'cash';
  }
  return 'venmo';
}

function hasReceiptPayload(receipt) {
  return Boolean(receipt && typeof receipt.dataUrl === 'string' && receipt.dataUrl.trim());
}

function createLatePickUpRequirementError(message, actionTime) {
  const error = new Error(message);
  error.requiresLateReason = true;
  error.requiresLatePayment = true;
  error.requiresLatePaymentReceipt = true;
  error.timingStatus = 'Late';
  error.action = 'pick_up';
  error.actionTime = actionTime;
  return error;
}

function saveLatePickUpReceipt(studentName, timestamp, receipt) {
  if (!hasReceiptPayload(receipt)) {
    return '';
  }

  const match = receipt.dataUrl.match(/^data:([^;]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) {
    throw new Error('Receipt upload must be a valid image file.');
  }

  const mimeType = match[1].toLowerCase();
  const extension = RECEIPT_MIME_EXTENSIONS[mimeType];
  if (!extension) {
    throw new Error('Receipt upload must be a JPG, PNG, GIF, or WebP image.');
  }

  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > MAX_RECEIPT_BYTES) {
    throw new Error('Receipt upload must be 5 MB or smaller.');
  }

  ensureReceiptDir();
  const safeStudent = String(studentName || 'student').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'student';
  const safeTimestamp = String(timestamp || Date.now()).replace(/[^a-z0-9]+/gi, '');
  const fileName = `${safeStudent}-${safeTimestamp}.${extension}`;
  fs.writeFileSync(path.join(receiptDir, fileName), bytes);
  return fileName;
}

function deleteLatePickUpReceipt(fileName) {
  const safeFileName = path.basename(fileName || '');
  if (!safeFileName) {
    return;
  }

  const filePath = path.resolve(receiptDir, safeFileName);
  const resolvedReceiptDir = path.resolve(receiptDir);
  if (!filePath.startsWith(resolvedReceiptDir + path.sep)) {
    return;
  }

  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.error('Failed to delete late pick-up receipt:', error.message || error);
  }
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
    pickUpLatePaymentConfirmed: normalizeBoolean(record.pickUpLatePaymentConfirmed),
    pickUpLatePaymentReceipt: record.pickUpLatePaymentReceipt || '',
    pickUpLatePaymentMethod: normalizePaymentMethod(record.pickUpLatePaymentMethod || record.pickUpLatePaymentMethod || DEFAULT_LATE_PAYMENT_METHOD),
    pickUpLatePaymentApproved: normalizeBoolean(record.pickUpLatePaymentApproved),
    pickUpLatePaymentAdminSignature: record.pickUpLatePaymentAdminSignature || '',
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

async function recordAttendanceAction(studentName, parentName, action, lateReason = '', latePaymentConfirmed = false, latePaymentReceipt = null, latePaymentMethod = DEFAULT_LATE_PAYMENT_METHOD, adminSignature = '') {
  const actionAt = new Date();
  const timestamp = actionAt.toISOString();
  const eventDate = formatArrivalDate(actionAt);
  const actionTime = formatArrivalTime(actionAt);
  const profile = await readAdminProfile();
  const trimmedLateReason = String(lateReason || '').trim();
  const paymentConfirmed = normalizeBoolean(latePaymentConfirmed);
  const paymentMethod = normalizePaymentMethod(latePaymentMethod);
  const trimmedAdminSignature = String(adminSignature || '').trim();

  let attendanceAction = normalizeAction(action);

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

    const currentRecord = existing.rows[0] || null;
    attendanceAction = resolveAttendanceAction(attendanceAction, currentRecord);
  } else {
    ensureAttendanceFile();
    const records = await readRecords();
    const sessionIndex = findSessionIndex(records, studentName, eventDate);
    const session = sessionIndex >= 0 ? records[sessionIndex] : null;
    attendanceAction = resolveAttendanceAction(attendanceAction, session || null);
  }

  const timingStatus = getActionTimingStatus(attendanceAction, timestamp, profile.scheduleSettings);

  if (timingStatus === 'Late' && !trimmedLateReason) {
    const actionLabel = attendanceAction === 'pick_up' ? 'pick-up' : 'drop-off';
    const error = new Error(`Please enter a reason for the late ${actionLabel}.`);
    error.requiresLateReason = true;
    error.requiresLatePayment = attendanceAction === 'pick_up';
    error.requiresLatePaymentReceipt = attendanceAction === 'pick_up';
    error.timingStatus = timingStatus;
    error.action = attendanceAction;
    error.actionTime = actionTime;
    throw error;
  }

  if (timingStatus === 'Late' && attendanceAction === 'pick_up' && !trimmedAdminSignature) {
    throw createLatePickUpRequirementError('Please enter the admin approval signature or initials for the late pick-up payment.', actionTime);
  }

  if (dbPool) {
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
      const currentRecord = existing.rows[0] || {};
      if (!canRecordPickup(currentRecord)) {
        throw new Error('This student has already been picked up today.');
      }

      const receiptFileName = timingStatus === 'Late'
        ? saveLatePickUpReceipt(studentName, timestamp, latePaymentReceipt)
        : '';

      await dbPool.query(`
        UPDATE attendance_records
        SET event_date = COALESCE(event_date, arrival_date),
            pick_up_parent_name = $1,
            pick_up_time = $2,
            pick_up_timestamp = $3,
            pick_up_late_reason = $4,
            pick_up_late_payment_confirmed = $5,
            pick_up_late_payment_receipt = $6,
            pick_up_late_payment_method = $7,
            pick_up_late_payment_approved = $8,
            pick_up_late_payment_admin_signature = $9
        WHERE id = $10
      `, [parentName, actionTime, timestamp, trimmedLateReason, false, receiptFileName, paymentMethod, false, trimmedAdminSignature, existing.rows[0].id]);
    }

    if (timingStatus === 'Late') {
      await trySendLateAttendanceEmail({
        studentName,
        parentName,
        action: attendanceAction,
        actionTime,
        eventDate,
        lateReason: trimmedLateReason,
        latePaymentConfirmed: attendanceAction === 'pick_up' && timingStatus === 'Late' ? paymentConfirmed : false,
        latePaymentReceipt: attendanceAction === 'pick_up' && timingStatus === 'Late' ? true : false,
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
      pickUpLatePaymentConfirmed: session?.pickUpLatePaymentConfirmed,
    });

    if (sessionIndex >= 0) {
      records[sessionIndex] = nextSession;
    } else {
      records.push(nextSession);
    }
  } else {
    if (!canRecordPickup(session || {})) {
      throw new Error('This student has already been picked up today.');
    }

    const receiptFileName = timingStatus === 'Late'
      ? saveLatePickUpReceipt(studentName, timestamp, latePaymentReceipt)
      : '';

    records[sessionIndex] = normalizeRecord({
      ...session,
      pickUpParentName: parentName,
      pickUpTime: actionTime,
      pickUpTimestamp: timestamp,
      pickUpLateReason: trimmedLateReason,
      pickUpLatePaymentConfirmed: false,
      pickUpLatePaymentReceipt: receiptFileName,
      pickUpLatePaymentMethod: paymentMethod,
      pickUpLatePaymentApproved: false,
      pickUpLatePaymentAdminSignature: trimmedAdminSignature,
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
      latePaymentConfirmed: attendanceAction === 'pick_up' && timingStatus === 'Late' && paymentMethod === 'venmo' ? paymentConfirmed : false,
      latePaymentReceipt: attendanceAction === 'pick_up' && timingStatus === 'Late' && paymentMethod === 'venmo' ? true : false,
      paymentMethod,
      adminSignature: trimmedAdminSignature,
      profile,
    });
  }
  return { action: attendanceAction, eventDate, actionTime, timestamp, timingStatus };
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

if (require.main === module) {
  app.listen(PORT, async () => {
    const profile = await readAdminProfile();
    console.log(`Event check-in app running at http://localhost:${PORT}`);
    console.log(`Admin page: http://localhost:${PORT}/admin`);
    console.log(`Admin username: ${profile.username}`);
    console.log(`Admin email: ${profile.email}`);
    console.log(`Admin storage: ${dbPool ? 'database' : adminFile}`);
    console.log(`Admin env override: USER=${Boolean(process.env.ADMIN_USER)}, EMAIL=${Boolean(process.env.ADMIN_EMAIL)}, PASS=${Boolean(process.env.ADMIN_PASS)}`);

    await checkAndSendPasswordReminder();
    setInterval(checkAndSendPasswordReminder, 24 * 60 * 60 * 1000);
  });
}

module.exports = {
  app,
  getStudentCheckInRequiredMessage,
  canRecordPickup,
  resolveAttendanceAction,
  normalizeAction,
  recordAttendanceAction,
};
