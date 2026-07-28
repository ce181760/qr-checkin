const express = require('express');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
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
const SMTP_TIMEOUT_MS = parseInt(process.env.SMTP_TIMEOUT_MS, 10) || 10000;
const REPORT_EMAIL = process.env.REPORT_EMAIL || '';
const DAILY_REPORT_EMAIL = process.env.DAILY_REPORT_EMAIL || REPORT_EMAIL;
const MONTHLY_REPORT_EMAIL = process.env.MONTHLY_REPORT_EMAIL || REPORT_EMAIL;
const BASE_URL = (process.env.BASE_URL || 'https://qr-checkin-e68h.onrender.com').replace(/\/$/, '');
const ARRIVAL_TIME_ZONE = 'America/New_York';
const DEFAULT_LATE_DROP_OFF_AFTER = '08:36';
const DEFAULT_LATE_PICK_UP_AFTER = '13:35';
const DEFAULT_SENDER_NAME = 'Event Check-In';
const LATE_PICK_UP_FEE_AMOUNT = '$10';
const LATE_PICK_UP_PAYMENT_HANDLE = '@phcs1166';
const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;
const RECEIPT_MIME_EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};
const MAX_REPORT_RECIPIENTS = 12;
const DAILY_REPORT_SEND_AFTER_HOUR = parseInt(process.env.DAILY_REPORT_SEND_AFTER_HOUR, 10) || 18;
const DEFAULT_DAILY_REPORT_SETTINGS = {
  reportMode: 'combined',
  combinedReportTime: `${String(DAILY_REPORT_SEND_AFTER_HOUR).padStart(2, '0')}:00`,
  dropOffReportTime: '10:30',
  pickUpReportTime: '18:00',
};
const dbPool = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
}) : null;
let adminTableReady = false;
let attendanceTableReady = false;

app.set('trust proxy', true);

app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function getAppBaseUrl(req) {
  if (BASE_URL) {
    return BASE_URL;
  }

  const protocol = req.protocol || 'http';
  const host = req.get('host') || `localhost:${PORT}`;
  return `${protocol}://${host}`;
}

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
    fs.writeFileSync(csvFile, 'StudentName,EventDate,DropOffParentName,DropOffTime,DropOffTimestamp,DropOffLateReason,PickUpParentName,PickUpTime,PickUpTimestamp,PickUpLateReason,PickUpLatePaymentConfirmed,PickUpLatePaymentReceipt\n', 'utf8');
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

function isValidEmailValue(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function normalizeReportRecipients(value, fallbackEmail = '') {
  let recipients = [];
  const hasExplicitValue = Array.isArray(value) || (typeof value === 'string' && value.trim() !== '');

  if (Array.isArray(value)) {
    recipients = value;
  } else if (typeof value === 'string' && value.trim().startsWith('[')) {
    try {
      recipients = JSON.parse(value);
    } catch (error) {
      recipients = [];
    }
  } else if (typeof value === 'string' && value.trim()) {
    recipients = value.split(',');
  }

  if (!recipients.length && fallbackEmail && !hasExplicitValue) {
    recipients = [fallbackEmail];
  }

  return [...new Set(recipients
    .map((email) => String(email || '').trim())
    .filter(Boolean))]
    .slice(0, MAX_REPORT_RECIPIENTS);
}

function getReportRecipientsWithSender(profile = {}) {
  const senderEmail = normalizeSenderSettings(profile).senderEmail;
  return normalizeReportRecipients([
    ...normalizeReportRecipients(profile.reportRecipients, profile.reportEmail || profile.email),
    senderEmail,
  ]);
}

function normalizeSenderSettings(profile = {}) {
  const settings = profile.senderSettings || {};
  const senderEmail = settings.senderEmail || profile.senderEmail || profile.sender_email || SMTP_USER || '';
  const senderAppPassword = settings.senderAppPassword || profile.senderAppPassword || profile.sender_app_password || SMTP_PASS || '';
  const senderName = settings.senderName || profile.senderName || profile.sender_name || DEFAULT_SENDER_NAME;

  return {
    senderEmail,
    senderAppPassword,
    senderName,
  };
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

function normalizeDailyReportSettings(settings = {}) {
  const source = settings || {};
  const reportMode = source.reportMode || source.report_mode;
  const combinedReportTime = source.combinedReportTime || source.combined_report_time || source.dailyReportTime || source.daily_report_time;
  const dropOffReportTime = source.dropOffReportTime || source.drop_off_report_time;
  const pickUpReportTime = source.pickUpReportTime || source.pick_up_report_time;

  return {
    reportMode: reportMode === 'separate' ? 'separate' : 'combined',
    combinedReportTime: isValidTimeValue(combinedReportTime) ? combinedReportTime : DEFAULT_DAILY_REPORT_SETTINGS.combinedReportTime,
    dropOffReportTime: isValidTimeValue(dropOffReportTime) ? dropOffReportTime : DEFAULT_DAILY_REPORT_SETTINGS.dropOffReportTime,
    pickUpReportTime: isValidTimeValue(pickUpReportTime) ? pickUpReportTime : DEFAULT_DAILY_REPORT_SETTINGS.pickUpReportTime,
  };
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

function getLocalMinutes(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ARRIVAL_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return (Number(values.hour) * 60) + Number(values.minute);
}

function shouldSendScheduledReport(now, reportTime) {
  const targetMinutes = timeToMinutes(reportTime);
  return targetMinutes !== null && getLocalMinutes(now) >= targetMinutes;
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
  await dbPool.query('ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS pick_up_late_payment_confirmed BOOLEAN DEFAULT FALSE');
  await dbPool.query('ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS pick_up_late_payment_receipt TEXT');
  attendanceTableReady = true;
}

function normalizeAction(action) {
  return action === 'pick_up' ? 'pick_up' : 'drop_off';
}

function normalizeBoolean(value) {
  return value === true || value === 'true' || value === 'on' || value === 1 || value === '1';
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

async function recordAttendanceAction(studentName, parentName, action, lateReason = '', latePaymentConfirmed = false, latePaymentReceipt = null) {
  const attendanceAction = normalizeAction(action);
  const actionAt = new Date();
  const timestamp = actionAt.toISOString();
  const eventDate = formatArrivalDate(actionAt);
  const actionTime = formatArrivalTime(actionAt);
  const profile = await readAdminProfile();
  const timingStatus = getActionTimingStatus(attendanceAction, timestamp, profile.scheduleSettings);
  const trimmedLateReason = String(lateReason || '').trim();
  const paymentConfirmed = normalizeBoolean(latePaymentConfirmed);

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

  if (timingStatus === 'Late' && attendanceAction === 'pick_up' && !paymentConfirmed) {
    throw createLatePickUpRequirementError(`Please confirm the ${LATE_PICK_UP_FEE_AMOUNT} late pick-up payment to ${LATE_PICK_UP_PAYMENT_HANDLE}.`, actionTime);
  }

  if (timingStatus === 'Late' && attendanceAction === 'pick_up' && !hasReceiptPayload(latePaymentReceipt)) {
    throw createLatePickUpRequirementError('Please upload a receipt screenshot for the late pick-up payment.', actionTime);
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
            pick_up_late_payment_receipt = $6
        WHERE id = $7
      `, [parentName, actionTime, timestamp, trimmedLateReason, timingStatus === 'Late' ? paymentConfirmed : false, receiptFileName, existing.rows[0].id]);
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
    if (!session?.dropOffTimestamp) {
      throw new Error('This student must be dropped off before they can be picked up.');
    }

    if (session.pickUpTimestamp) {
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
      pickUpLatePaymentConfirmed: timingStatus === 'Late' ? paymentConfirmed : false,
      pickUpLatePaymentReceipt: receiptFileName,
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
      latePaymentConfirmed: attendanceAction === 'pick_up' && timingStatus === 'Late' ? paymentConfirmed : false,
      latePaymentReceipt: attendanceAction === 'pick_up' && timingStatus === 'Late' ? true : false,
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
  const validIdentifiers = [profile.username, profile.email, profile.phone].filter(Boolean);

  if (validIdentifiers.includes(user) && pass === profile.password) {
    return next();
  }

  return res.status(403).send('Forbidden');
}

app.post('/checkin', async (req, res) => {
  const studentName = (req.body.studentName || '').trim();
  const parentName = (req.body.parentName || '').trim();
  const action = normalizeAction(req.body.action);
  const lateReason = (req.body.lateReason || '').trim();
  const latePaymentConfirmed = req.body.latePaymentConfirmed;
  const latePaymentReceipt = req.body.latePaymentReceipt || null;
  if (!studentName || !parentName) {
    return res.status(400).json({ error: 'Student name and parent name are required' });
  }

  try {
    const attendance = await recordAttendanceAction(studentName, parentName, action, lateReason, latePaymentConfirmed, latePaymentReceipt);
    return res.json({ success: true, studentName, parentName, ...attendance });
  } catch (error) {
    if (error.requiresLateReason) {
      return res.status(409).json({
        error: error.message,
        requiresLateReason: true,
        requiresLatePayment: Boolean(error.requiresLatePayment),
        requiresLatePaymentReceipt: Boolean(error.requiresLatePaymentReceipt),
        action: error.action,
        actionTime: error.actionTime,
        timingStatus: error.timingStatus,
        latePickUpFeeAmount: LATE_PICK_UP_FEE_AMOUNT,
        latePickUpPaymentHandle: LATE_PICK_UP_PAYMENT_HANDLE,
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

app.get('/admin/report-settings', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-report-settings.html'));
});

app.get('/admin/sender-settings', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-sender-settings.html'));
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
    phone: '',
    reportEmail: REPORT_EMAIL || ADMIN_EMAIL,
    dailyReportEmail: DAILY_REPORT_EMAIL || REPORT_EMAIL || ADMIN_EMAIL,
    monthlyReportEmail: MONTHLY_REPORT_EMAIL || REPORT_EMAIL || ADMIN_EMAIL,
    reportRecipients: normalizeReportRecipients([DAILY_REPORT_EMAIL, MONTHLY_REPORT_EMAIL, REPORT_EMAIL], ADMIN_EMAIL),
    senderSettings: normalizeSenderSettings(),
    lastPasswordChange: new Date().toISOString(),
    lastReminderSent: null,
    lastDailyReportSent: null,
    lastDailyDropOffReportSent: null,
    lastDailyPickUpReportSent: null,
    lastMonthlyReportSent: null,
    scheduleSettings: normalizeScheduleSettings(),
    dailyReportSettings: normalizeDailyReportSettings(),
  };
}

function normalizeAdminEmail(email) {
  const defaultEmail = ADMIN_EMAIL || 'admin@example.com';
  if (email && email !== 'admin@example.com') {
    return email;
  }
  return defaultEmail;
}

function normalizeAdminProfile(profile) {
  const email = normalizeAdminEmail(profile.email);
  return {
    username: profile.username || ADMIN_USER,
    password: profile.password || ADMIN_PASS,
    email,
    phone: profile.phone || profile.phone_number || '',
    reportEmail: profile.reportEmail || profile.report_email || REPORT_EMAIL || profile.email || email,
    dailyReportEmail: profile.dailyReportEmail || profile.daily_report_email || profile.reportEmail || profile.report_email || DAILY_REPORT_EMAIL || REPORT_EMAIL || profile.email || email,
    monthlyReportEmail: profile.monthlyReportEmail || profile.monthly_report_email || profile.reportEmail || profile.report_email || MONTHLY_REPORT_EMAIL || REPORT_EMAIL || profile.email || email,
    reportRecipients: normalizeReportRecipients(
      profile.reportRecipients || profile.report_recipients,
      profile.reportEmail || profile.report_email || REPORT_EMAIL || profile.email || ADMIN_EMAIL
    ),
    senderSettings: normalizeSenderSettings(profile),
    lastPasswordChange: profile.lastPasswordChange || profile.last_password_change || profile.lastPasswordReminder || new Date().toISOString(),
    lastReminderSent: profile.lastReminderSent || profile.last_reminder_sent || profile.lastPasswordReminder || null,
    lastDailyReportSent: profile.lastDailyReportSent || profile.last_daily_report_sent || null,
    lastDailyDropOffReportSent: profile.lastDailyDropOffReportSent || profile.last_daily_drop_off_report_sent || null,
    lastDailyPickUpReportSent: profile.lastDailyPickUpReportSent || profile.last_daily_pick_up_report_sent || null,
    lastMonthlyReportSent: profile.lastMonthlyReportSent || profile.last_monthly_report_sent || null,
    scheduleSettings: normalizeScheduleSettings({
      lateDropOffAfter: profile.lateDropOffAfter,
      latePickUpAfter: profile.latePickUpAfter,
      late_drop_off_after: profile.late_drop_off_after,
      late_pick_up_after: profile.late_pick_up_after,
      ...(profile.scheduleSettings || {}),
    }),
    dailyReportSettings: normalizeDailyReportSettings({
      reportMode: profile.reportMode,
      report_mode: profile.report_mode,
      combinedReportTime: profile.combinedReportTime,
      combined_report_time: profile.combined_report_time,
      dailyReportTime: profile.dailyReportTime,
      daily_report_time: profile.daily_report_time,
      dropOffReportTime: profile.dropOffReportTime,
      drop_off_report_time: profile.drop_off_report_time,
      pickUpReportTime: profile.pickUpReportTime,
      pick_up_report_time: profile.pick_up_report_time,
      ...(profile.dailyReportSettings || {}),
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
      report_email TEXT,
      daily_report_email TEXT,
      monthly_report_email TEXT,
      report_recipients TEXT,
      sender_email TEXT,
      sender_app_password TEXT,
      sender_name TEXT,
      last_password_change TIMESTAMPTZ NOT NULL,
      last_reminder_sent TIMESTAMPTZ,
      last_daily_report_sent TEXT,
      last_daily_drop_off_report_sent TEXT,
      last_daily_pick_up_report_sent TEXT,
      last_monthly_report_sent TEXT,
      late_drop_off_after TEXT,
      late_pick_up_after TEXT,
      daily_report_mode TEXT,
      combined_report_time TEXT,
      drop_off_report_time TEXT,
      pick_up_report_time TEXT
    )
  `);
  await dbPool.query('ALTER TABLE admin_profile ADD COLUMN IF NOT EXISTS phone TEXT');
  await dbPool.query('ALTER TABLE admin_profile ADD COLUMN IF NOT EXISTS report_email TEXT');
  await dbPool.query('ALTER TABLE admin_profile ADD COLUMN IF NOT EXISTS daily_report_email TEXT');
  await dbPool.query('ALTER TABLE admin_profile ADD COLUMN IF NOT EXISTS monthly_report_email TEXT');
  await dbPool.query('ALTER TABLE admin_profile ADD COLUMN IF NOT EXISTS report_recipients TEXT');
  await dbPool.query('ALTER TABLE admin_profile ADD COLUMN IF NOT EXISTS sender_email TEXT');
  await dbPool.query('ALTER TABLE admin_profile ADD COLUMN IF NOT EXISTS sender_app_password TEXT');
  await dbPool.query('ALTER TABLE admin_profile ADD COLUMN IF NOT EXISTS sender_name TEXT');
  await dbPool.query('ALTER TABLE admin_profile ADD COLUMN IF NOT EXISTS last_daily_report_sent TEXT');
  await dbPool.query('ALTER TABLE admin_profile ADD COLUMN IF NOT EXISTS last_daily_drop_off_report_sent TEXT');
  await dbPool.query('ALTER TABLE admin_profile ADD COLUMN IF NOT EXISTS last_daily_pick_up_report_sent TEXT');
  await dbPool.query('ALTER TABLE admin_profile ADD COLUMN IF NOT EXISTS last_monthly_report_sent TEXT');
  await dbPool.query('ALTER TABLE admin_profile ADD COLUMN IF NOT EXISTS late_drop_off_after TEXT');
  await dbPool.query('ALTER TABLE admin_profile ADD COLUMN IF NOT EXISTS late_pick_up_after TEXT');
  await dbPool.query('ALTER TABLE admin_profile ADD COLUMN IF NOT EXISTS daily_report_mode TEXT');
  await dbPool.query('ALTER TABLE admin_profile ADD COLUMN IF NOT EXISTS combined_report_time TEXT');
  await dbPool.query('ALTER TABLE admin_profile ADD COLUMN IF NOT EXISTS drop_off_report_time TEXT');
  await dbPool.query('ALTER TABLE admin_profile ADD COLUMN IF NOT EXISTS pick_up_report_time TEXT');
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
        id, username, password, email, phone, report_email, daily_report_email, monthly_report_email,
        report_recipients, sender_email, sender_app_password, sender_name,
        last_password_change, last_reminder_sent,
        last_daily_report_sent, last_daily_drop_off_report_sent, last_daily_pick_up_report_sent,
        last_monthly_report_sent, late_drop_off_after, late_pick_up_after,
        daily_report_mode, combined_report_time, drop_off_report_time, pick_up_report_time
      )
      VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
      ON CONFLICT (id) DO UPDATE SET
        username = EXCLUDED.username,
        password = EXCLUDED.password,
        email = EXCLUDED.email,
        phone = EXCLUDED.phone,
        report_email = EXCLUDED.report_email,
        daily_report_email = EXCLUDED.daily_report_email,
        monthly_report_email = EXCLUDED.monthly_report_email,
        report_recipients = EXCLUDED.report_recipients,
        sender_email = EXCLUDED.sender_email,
        sender_app_password = EXCLUDED.sender_app_password,
        sender_name = EXCLUDED.sender_name,
        last_password_change = EXCLUDED.last_password_change,
        last_reminder_sent = EXCLUDED.last_reminder_sent,
        last_daily_report_sent = EXCLUDED.last_daily_report_sent,
        last_daily_drop_off_report_sent = EXCLUDED.last_daily_drop_off_report_sent,
        last_daily_pick_up_report_sent = EXCLUDED.last_daily_pick_up_report_sent,
        last_monthly_report_sent = EXCLUDED.last_monthly_report_sent,
        late_drop_off_after = EXCLUDED.late_drop_off_after,
        late_pick_up_after = EXCLUDED.late_pick_up_after,
        daily_report_mode = EXCLUDED.daily_report_mode,
        combined_report_time = EXCLUDED.combined_report_time,
        drop_off_report_time = EXCLUDED.drop_off_report_time,
        pick_up_report_time = EXCLUDED.pick_up_report_time
    `, [
      profile.username,
      profile.password,
      profile.email,
      profile.phone || '',
      profile.reportEmail || profile.email,
      profile.dailyReportEmail || profile.reportEmail || profile.email,
      profile.monthlyReportEmail || profile.reportEmail || profile.email,
      JSON.stringify(normalizeReportRecipients(profile.reportRecipients)),
      normalizeSenderSettings(profile).senderEmail,
      normalizeSenderSettings(profile).senderAppPassword,
      normalizeSenderSettings(profile).senderName,
      profile.lastPasswordChange || new Date().toISOString(),
      profile.lastReminderSent || null,
      profile.lastDailyReportSent || null,
      profile.lastDailyDropOffReportSent || null,
      profile.lastDailyPickUpReportSent || null,
      profile.lastMonthlyReportSent || null,
      normalizeScheduleSettings(profile.scheduleSettings).lateDropOffAfter,
      normalizeScheduleSettings(profile.scheduleSettings).latePickUpAfter,
      normalizeDailyReportSettings(profile.dailyReportSettings).reportMode,
      normalizeDailyReportSettings(profile.dailyReportSettings).combinedReportTime,
      normalizeDailyReportSettings(profile.dailyReportSettings).dropOffReportTime,
      normalizeDailyReportSettings(profile.dailyReportSettings).pickUpReportTime,
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

function getMailTransport(profile = {}) {
  const senderSettings = normalizeSenderSettings(profile);
  const host = SMTP_HOST || 'smtp.gmail.com';
  const authUser = senderSettings.senderEmail || SMTP_USER;
  const authPass = senderSettings.senderAppPassword || SMTP_PASS;

  if (!authUser || !authPass || authPass === 'your-app-password' || authPass === 'your-sender-app-password') {
    return null;
  }

  return nodemailer.createTransport({
    host,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: { user: authUser, pass: authPass },
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
  });
}

function getMailFrom(profile = {}) {
  const senderSettings = normalizeSenderSettings(profile);
  const senderEmail = senderSettings.senderEmail || SMTP_USER;
  const senderName = senderSettings.senderName || DEFAULT_SENDER_NAME;
  return senderEmail ? `${senderName} <${senderEmail}>` : SMTP_FROM;
}

async function sendPasswordReminder(profile) {
  const transporter = getMailTransport(profile);
  const subject = 'Admin password reminder';
  const text = `Hello ${profile.username},\n\nThis is a reminder to change your admin password. It has been one month since the last reminder.\n\nIf you have already changed your password, you can ignore this message.\n\nThanks.`;

  if (!transporter) {
    console.log('SMTP not configured. Password reminder email not sent.');
    return false;
  }

  await transporter.sendMail({
    from: getMailFrom(profile),
    to: profile.email,
    subject,
    text,
  });

  return true;
}

async function sendLateAttendanceEmail(details) {
  const transporter = getMailTransport(details.profile);
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
    details.action === 'pick_up' ? `Late pick-up payment: ${details.latePaymentConfirmed ? `Confirmed ${LATE_PICK_UP_FEE_AMOUNT} to ${LATE_PICK_UP_PAYMENT_HANDLE}` : 'Not confirmed'}` : '',
    details.action === 'pick_up' ? `Receipt uploaded: ${details.latePaymentReceipt ? 'Yes' : 'No'}` : '',
  ].filter((line) => line !== '').join('\n');

  await transporter.sendMail({
    from: getMailFrom(details.profile),
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

function formatDailyReportRecord(record) {
  const lateLabels = (record.timingFlags || []).join(', ') || 'None';
  const dropOff = record.dropOffTimestamp
    ? `${record.dropOffParentName || 'Unknown parent'} at ${record.dropOffTime || formatArrivalTime(new Date(record.dropOffTimestamp))}`
    : 'Not recorded';
  const pickUp = record.pickUpTimestamp
    ? `${record.pickUpParentName || 'Unknown parent'} at ${record.pickUpTime || formatArrivalTime(new Date(record.pickUpTimestamp))}`
    : 'Not recorded';
  const reasons = [
    record.dropOffLateReason ? `Drop-off reason: ${record.dropOffLateReason}` : '',
    record.pickUpLateReason ? `Pick-up reason: ${record.pickUpLateReason}` : '',
    record.pickUpLateReason ? `Pick-up payment: ${record.pickUpLatePaymentConfirmed ? `Confirmed ${LATE_PICK_UP_FEE_AMOUNT} to ${LATE_PICK_UP_PAYMENT_HANDLE}` : 'Not confirmed'}` : '',
    record.pickUpLateReason ? `Pick-up receipt: ${record.pickUpLatePaymentReceipt ? 'Uploaded' : 'Missing'}` : '',
  ].filter(Boolean).join(' | ') || 'No late reason';

  return [
    `Student: ${record.studentName || 'Unknown student'}`,
    `Status: ${record.status || getSessionStatus(record)}`,
    `Late labels: ${lateLabels}`,
    `Drop-off: ${dropOff}`,
    `Pick-up: ${pickUp}`,
    reasons,
  ].join('\n');
}

function getLocalDateParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ARRIVAL_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
  };
}

function getPreviousMonthReportPeriod(referenceDate = new Date()) {
  const current = getLocalDateParts(referenceDate);
  const year = current.month === 1 ? current.year - 1 : current.year;
  const month = current.month === 1 ? 12 : current.month - 1;
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const monthText = String(month).padStart(2, '0');
  const nextMonthText = String(nextMonth).padStart(2, '0');
  const label = new Intl.DateTimeFormat('en-US', {
    month: 'long',
    year: 'numeric',
  }).format(new Date(Date.UTC(year, month - 1, 1)));

  return {
    key: `${year}-${monthText}`,
    label,
    startDate: `${year}-${monthText}-01`,
    endDate: `${nextYear}-${nextMonthText}-01`,
  };
}

function filterRecordsForPeriod(records, period) {
  return records.filter((record) => {
    const eventDate = record.eventDate || record.arrivalDate;
    return eventDate >= period.startDate && eventDate < period.endDate;
  });
}

function escapePdfText(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function createReportPdfBuffer(title, text) {
  const lines = String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .flatMap((line) => {
      if (!line) return [''];
      const chunks = [];
      for (let index = 0; index < line.length; index += 95) {
        chunks.push(line.slice(index, index + 95));
      }
      return chunks;
    });
  const pages = [];
  const linesPerPage = 46;

  for (let index = 0; index < lines.length || index === 0; index += linesPerPage) {
    pages.push(lines.slice(index, index + linesPerPage));
  }

  const objects = [];
  const addObject = (content) => {
    objects.push(content);
    return objects.length;
  };
  const catalogId = addObject('');
  const pagesId = addObject('');
  const fontId = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageIds = [];

  pages.forEach((pageLines) => {
    const textCommands = [
      'BT',
      '/F1 11 Tf',
      '50 760 Td',
      '14 TL',
      `(${escapePdfText(title)}) Tj`,
      'T*',
      'T*',
      ...pageLines.map((line) => `(${escapePdfText(line)}) Tj T*`),
      'ET',
    ].join('\n');
    const contentId = addObject(`<< /Length ${Buffer.byteLength(textCommands, 'utf8')} >>\nstream\n${textCommands}\nendstream`);
    const pageId = addObject(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    pageIds.push(pageId);
  });

  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((content, index) => {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += `${index + 1} 0 obj\n${content}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, 'utf8');
}

async function sendDailyRecordReport(profile, reportDate = formatArrivalDate(new Date()), reportKind = 'combined') {
  const transporter = getMailTransport(profile);
  const recipients = getReportRecipientsWithSender(profile);
  if (!transporter) {
    console.log('SMTP not configured. Daily record report email not sent.');
    return false;
  }

  if (!recipients.length || recipients.some((email) => !isValidEmailValue(email))) {
    const error = new Error('Enter a valid receiver email.');
    error.statusCode = 400;
    throw error;
  }

  const allRecords = (await readRecords()).filter((record) => (
    (record.eventDate || record.arrivalDate) === reportDate
  ));
  const records = allRecords.filter((record) => {
    if (reportKind === 'drop_off') {
      return Boolean(record.dropOffTimestamp || record.timestamp);
    }
    if (reportKind === 'pick_up') {
      return Boolean(record.pickUpTimestamp);
    }
    return true;
  });
  const reportLabel = reportKind === 'drop_off'
    ? 'Daily drop-off report'
    : reportKind === 'pick_up'
      ? 'Daily pick-up report'
      : 'Daily attendance report';
  const emptyMessage = reportKind === 'drop_off'
    ? 'No drop-off records were found for this date.'
    : reportKind === 'pick_up'
      ? 'No pick-up records were found for this date.'
      : 'No attendance records were found for this date.';
  const reportBody = records.length
    ? records.map(formatDailyReportRecord).join('\n\n---\n\n')
    : emptyMessage;
  const text = [
    `${reportLabel} for ${reportDate}`,
    '',
    `Total records: ${records.length}`,
    '',
    reportBody,
  ].join('\n');

  await transporter.sendMail({
    from: getMailFrom(profile),
    to: recipients,
    subject: `${reportLabel} - ${reportDate}`,
    text,
    attachments: [{
      filename: `${reportLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${reportDate}.pdf`,
      content: createReportPdfBuffer(`${reportLabel} - ${reportDate}`, text),
      contentType: 'application/pdf',
    }],
  });

  return true;
}

async function sendMonthlyRecordReport(profile, period = getPreviousMonthReportPeriod()) {
  const transporter = getMailTransport(profile);
  const recipients = getReportRecipientsWithSender(profile);
  if (!transporter) {
    console.log('SMTP not configured. Monthly record report email not sent.');
    return false;
  }

  if (!recipients.length || recipients.some((email) => !isValidEmailValue(email))) {
    const error = new Error('Enter a valid receiver email.');
    error.statusCode = 400;
    throw error;
  }

  const records = filterRecordsForPeriod(await readRecords(), period);
  const lateRecordCount = records.filter((record) => (
    record.dropOffLateReason || record.pickUpLateReason || (record.timingFlags || []).length
  )).length;
  const reportBody = records.length
    ? records.map(formatDailyReportRecord).join('\n\n---\n\n')
    : 'No attendance records were found for this month.';
  const text = [
    `Monthly attendance report for ${period.label}`,
    '',
    `Total records: ${records.length}`,
    `Records with late activity: ${lateRecordCount}`,
    '',
    reportBody,
  ].join('\n');

  await transporter.sendMail({
    from: getMailFrom(profile),
    to: recipients,
    subject: `Monthly attendance report - ${period.label}`,
    text,
    attachments: [{
      filename: `monthly-attendance-report-${period.key}.pdf`,
      content: createReportPdfBuffer(`Monthly attendance report - ${period.label}`, text),
      contentType: 'application/pdf',
    }],
  });

  return true;
}

async function checkAndSendMonthlyReport() {
  const today = getLocalDateParts(new Date());
  if (today.day !== 1) {
    return;
  }

  const period = getPreviousMonthReportPeriod();
  const profile = await readAdminProfile();
  if (profile.lastMonthlyReportSent === period.key) {
    return;
  }

  try {
    const sent = await sendMonthlyRecordReport(profile, period);
    if (sent) {
      profile.lastMonthlyReportSent = period.key;
      await writeAdminProfile(profile);
      console.log(`Monthly report for ${period.label} sent to ${getReportRecipientsWithSender(profile).join(', ')}`);
    }
  } catch (error) {
    console.error('Failed to send monthly report:', error.message || error);
  }
}

async function checkAndSendDailyReport() {
  const now = new Date();
  const reportDate = formatArrivalDate(now);
  const profile = await readAdminProfile();
  const dailyReportSettings = normalizeDailyReportSettings(profile.dailyReportSettings);

  if (dailyReportSettings.reportMode === 'separate') {
    try {
      let profileChanged = false;
      if (
        profile.lastDailyDropOffReportSent !== reportDate
        && shouldSendScheduledReport(now, dailyReportSettings.dropOffReportTime)
      ) {
        const sent = await sendDailyRecordReport(profile, reportDate, 'drop_off');
        if (sent) {
          profile.lastDailyDropOffReportSent = reportDate;
          profileChanged = true;
          console.log(`Daily drop-off report for ${reportDate} sent to ${getReportRecipientsWithSender(profile).join(', ')}`);
        }
      }

      if (
        profile.lastDailyPickUpReportSent !== reportDate
        && shouldSendScheduledReport(now, dailyReportSettings.pickUpReportTime)
      ) {
        const sent = await sendDailyRecordReport(profile, reportDate, 'pick_up');
        if (sent) {
          profile.lastDailyPickUpReportSent = reportDate;
          profileChanged = true;
          console.log(`Daily pick-up report for ${reportDate} sent to ${getReportRecipientsWithSender(profile).join(', ')}`);
        }
      }

      if (profileChanged) {
        await writeAdminProfile(profile);
      }
    } catch (error) {
      console.error('Failed to send separate daily report:', error.message || error);
    }
    return;
  }

  if (
    profile.lastDailyReportSent === reportDate
    || !shouldSendScheduledReport(now, dailyReportSettings.combinedReportTime)
  ) {
    return;
  }

  try {
    const sent = await sendDailyRecordReport(profile, reportDate, 'combined');
    if (sent) {
      profile.lastDailyReportSent = reportDate;
      await writeAdminProfile(profile);
      console.log(`Daily report for ${reportDate} sent to ${getReportRecipientsWithSender(profile).join(', ')}`);
    }
  } catch (error) {
    console.error('Failed to send daily report:', error.message || error);
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
        pick_up_late_reason, pick_up_late_payment_confirmed, pick_up_late_payment_receipt
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
      pickUpLatePaymentConfirmed: record.pick_up_late_payment_confirmed,
      pickUpLatePaymentReceipt: record.pick_up_late_payment_receipt,
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
    } else if (values.length >= 10) {
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
        pickUpLatePaymentConfirmed: values[10] === 'true',
        pickUpLatePaymentReceipt: values[11] || '',
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
    'StudentName,EventDate,DropOffParentName,DropOffTime,DropOffTimestamp,DropOffLateReason,PickUpParentName,PickUpTime,PickUpTimestamp,PickUpLateReason,PickUpLatePaymentConfirmed,PickUpLatePaymentReceipt',
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
        normalized.pickUpLatePaymentConfirmed ? 'true' : 'false',
        normalized.pickUpLatePaymentReceipt,
      ].map((value) => `"${escapeCsv(value)}"`).join(',');
    }),
  ];
  fs.writeFileSync(csvFile, csvLines.join('\n') + '\n', 'utf8');
}

app.post('/api/admin/login', async (req, res) => {
  const identifier = String(req.body.identifier || req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!identifier || !password) {
    return res.status(400).json({ error: 'Username/email/phone and password are required' });
  }

  const profile = await readAdminProfile();
  const validIdentifiers = [profile.username, profile.email, profile.phone].filter(Boolean);
  if (validIdentifiers.includes(identifier) && password === profile.password) {
    return res.json({ username: profile.username, email: profile.email, phone: profile.phone, passwordChangeRequired: isPasswordChangeRequired(profile) });
  }

  return res.status(403).json({ error: 'Invalid username/email/phone or password' });
});

app.get('/api/admin/profile', basicAuth, async (req, res) => {
  const profile = await readAdminProfile();
  res.json({ username: profile.username, email: profile.email, phone: profile.phone, passwordChangeRequired: isPasswordChangeRequired(profile) });
});

app.post('/api/admin/profile', basicAuth, async (req, res) => {
  const { username, password, email, phone } = req.body;
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
    phone: String(phone || currentProfile.phone || '').trim(),
    reportEmail: currentProfile.reportEmail || email,
    dailyReportEmail: currentProfile.dailyReportEmail || currentProfile.reportEmail || email,
    monthlyReportEmail: currentProfile.monthlyReportEmail || currentProfile.reportEmail || email,
    reportRecipients: currentProfile.reportRecipients || normalizeReportRecipients(currentProfile.reportEmail || email),
    senderSettings: currentProfile.senderSettings || normalizeSenderSettings(currentProfile),
    lastPasswordChange: new Date().toISOString(),
    lastReminderSent: currentProfile.lastReminderSent || null,
    lastMonthlyReportSent: currentProfile.lastMonthlyReportSent || null,
    scheduleSettings: currentProfile.scheduleSettings,
  };
  await writeAdminProfile(profile);
  return res.json({ username: profile.username, email: profile.email, phone: profile.phone, passwordChangeRequired: false });
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

app.get('/admin/forgot', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-forgot.html'));
});

app.get('/admin/forgot-username', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-forgot-username.html'));
});

app.get('/admin/reset', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-reset.html'));
});

app.get('/admin/reset.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-reset.html'));
});

app.post('/api/admin/forgot-username', async (req, res) => {
  const identifier = String(req.body.identifier || '').trim();
  if (!identifier) {
    return res.status(400).json({ error: 'Email or phone is required' });
  }

  try {
    const profile = await readAdminProfile();
    const normalizedProfile = { ...profile };
    if (normalizedProfile.email === 'admin@example.com' && identifier.includes('@')) {
      normalizedProfile.email = identifier;
    }

    const emailMatches = identifier && normalizedProfile.email && identifier === normalizedProfile.email;
    const phoneMatches = identifier && normalizedProfile.phone && identifier === normalizedProfile.phone;
    if (!emailMatches && !phoneMatches) {
      return res.status(400).json({ error: 'No matching admin account' });
    }

    const transporter = getMailTransport(normalizedProfile);
    if (transporter && normalizedProfile.email) {
      const subject = 'Your admin username';
      const text = `Hello ${profile.username},\n\nYour admin username is: ${profile.username}\n\nIf you did not request this, you can ignore this message.\n`;
      const html = `<!DOCTYPE html><html><body><p>Hello ${profile.username},</p><p>Your admin username is: <strong>${profile.username}</strong></p><p>If you did not request this, you can ignore this message.</p></body></html>`;

      await transporter.sendMail({ from: getMailFrom(normalizedProfile), to: normalizedProfile.email, subject, text, html });
      return res.json({ success: true, emailSent: true });
    }

    return res.json({ success: true, emailSent: false, username: profile.username, note: 'SMTP not configured, showing username directly.' });
  } catch (error) {
    console.error('Forgot username error:', error.message || error);
    return res.status(500).json({ error: 'Unable to process request' });
  }
});

app.post('/api/admin/forgot', async (req, res) => {
  const identifier = String(req.body.identifier || req.body.email || req.body.username || '').trim();
  if (!identifier) {
    return res.status(400).json({ error: 'Email or username is required' });
  }

  try {
    const profile = await readAdminProfile();
    if (profile.email === 'admin@example.com' && identifier && identifier.includes('@')) {
      profile.email = identifier;
    }

    const emailMatches = identifier && profile.email && identifier === profile.email;
    const usernameMatches = identifier && identifier === profile.username;
    if (!emailMatches && !usernameMatches) {
      return res.status(400).json({ error: 'No matching admin account' });
    }

    // generate reset token
    const token = crypto.randomBytes(20).toString('hex');
    profile.resetToken = token;
    profile.resetTokenExpiry = Date.now() + (60 * 60 * 1000); // 1 hour
    await writeAdminProfile(profile);

    const transporter = getMailTransport(profile);
    if (!transporter) {
      console.log('SMTP not configured. Cannot send password reset.');
      return res.status(500).json({ error: 'SMTP not configured' });
    }

    const resetUrl = `${getAppBaseUrl(req)}/admin/reset?token=${token}`;
    const subject = 'Reset your admin password';
    const text = `Hello ${profile.username},\n\nA request to reset the admin password was received.\n\nIf you requested this, open the link below and set a new password (link expires in 1 hour):\n\n${resetUrl}\n\nIf you did not request this, you can ignore this message.\n`;
    const html = `<!DOCTYPE html><html><body><p>Hello ${profile.username},</p><p>A request to reset the admin password was received.</p><p><a href="${resetUrl}">Click here to reset your password</a></p><p>This link expires in 1 hour.</p><p>If you did not request this, you can ignore this message.</p></body></html>`;

    await transporter.sendMail({ from: getMailFrom(profile), to: profile.email, subject, text, html });
    return res.json({ success: true });
  } catch (error) {
    console.error('Forgot password error:', error.message || error);
    return res.status(500).json({ error: 'Unable to process request' });
  }
});

app.post('/api/admin/reset', async (req, res) => {
  const token = String(req.body.token || '').trim();
  const password = String(req.body.password || '');
  if (!token || !password) {
    return res.status(400).json({ error: 'Token and new password are required' });
  }

  try {
    const profile = await readAdminProfile();
    if (!profile.resetToken || profile.resetToken !== token || !profile.resetTokenExpiry || Date.now() > Number(profile.resetTokenExpiry)) {
      return res.status(400).json({ error: 'Invalid or expired token' });
    }

    profile.password = password;
    delete profile.resetToken;
    delete profile.resetTokenExpiry;
    profile.lastPasswordChange = new Date().toISOString();
    await writeAdminProfile(profile);

    return res.json({ success: true });
  } catch (error) {
    console.error('Reset password error:', error.message || error);
    return res.status(500).json({ error: 'Unable to reset password' });
  }
});

app.get('/api/admin/report-settings', basicAuth, async (req, res) => {
  const profile = await readAdminProfile();
  res.json({
    reportRecipients: normalizeReportRecipients(profile.reportRecipients, profile.reportEmail || profile.email),
    maxReportRecipients: MAX_REPORT_RECIPIENTS,
  });
});

app.post('/api/admin/report-settings', basicAuth, async (req, res) => {
  const rawRecipients = Array.isArray(req.body.reportRecipients)
    ? req.body.reportRecipients
    : normalizeReportRecipients(req.body.reportRecipients || req.body.reportEmail);
  if (rawRecipients.length > MAX_REPORT_RECIPIENTS) {
    return res.status(400).json({ error: `You can add up to ${MAX_REPORT_RECIPIENTS} report receivers.` });
  }

  const reportRecipients = normalizeReportRecipients(req.body.reportRecipients || req.body.reportEmail);
  if (reportRecipients.some((email) => !isValidEmailValue(email))) {
    return res.status(400).json({ error: 'Every report receiver must be a valid email address.' });
  }

  const profile = await readAdminProfile();
  await writeAdminProfile({
    ...profile,
    reportEmail: reportRecipients[0] || profile.reportEmail,
    dailyReportEmail: reportRecipients[0] || profile.dailyReportEmail,
    monthlyReportEmail: reportRecipients[0] || profile.monthlyReportEmail,
    reportRecipients,
  });

  res.json({ reportRecipients, maxReportRecipients: MAX_REPORT_RECIPIENTS });
});

app.get('/api/admin/sender-settings', basicAuth, async (req, res) => {
  const profile = await readAdminProfile();
  const senderSettings = normalizeSenderSettings(profile);
  res.json({
    senderEmail: senderSettings.senderEmail,
    senderName: senderSettings.senderName,
    dailyReportSettings: normalizeDailyReportSettings(profile.dailyReportSettings),
    hasSenderAppPassword: Boolean(senderSettings.senderAppPassword && !senderSettings.senderAppPassword.startsWith('your-')),
  });
});

app.post('/api/admin/sender-settings', basicAuth, async (req, res) => {
  const senderEmail = String(req.body.senderEmail || '').trim();
  const senderAppPassword = String(req.body.senderAppPassword || '').trim();
  const senderName = String(req.body.senderName || DEFAULT_SENDER_NAME).trim() || DEFAULT_SENDER_NAME;

  if (!isValidEmailValue(senderEmail)) {
    return res.status(400).json({ error: 'Sender email must be a valid email address.' });
  }

  const profile = await readAdminProfile();
  const existingSenderSettings = normalizeSenderSettings(profile);
  if (!senderAppPassword && !existingSenderSettings.senderAppPassword) {
    return res.status(400).json({ error: 'Sender app password is required.' });
  }

  await writeAdminProfile({
    ...profile,
    senderSettings: {
      senderEmail,
      senderAppPassword: senderAppPassword || existingSenderSettings.senderAppPassword,
      senderName,
    },
  });

  res.json({ senderEmail, senderName, hasSenderAppPassword: true });
});

app.post('/api/admin/daily-report-settings', basicAuth, async (req, res) => {
  const dailyReportSettings = normalizeDailyReportSettings(req.body.dailyReportSettings || {});
  const profile = await readAdminProfile();

  await writeAdminProfile({
    ...profile,
    dailyReportSettings,
  });

  res.json({ dailyReportSettings });
});

app.post('/api/admin/daily-report/email', basicAuth, async (req, res) => {
  try {
    const profile = await readAdminProfile();
    const sent = await sendDailyRecordReport(profile);

    if (!sent) {
      return res.status(503).json({ error: 'Sender settings are not configured. Add sender email and app password before emailing reports.' });
    }

    return res.json({ message: 'Daily report sent.' });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    return res.status(statusCode).json({ error: error.message || 'Unable to email daily report' });
  }
});

app.get('/api/records', basicAuth, async (req, res) => {
  res.json(await readRecords());
});

app.get('/api/late-pickup-receipts/:fileName', basicAuth, (req, res) => {
  const fileName = path.basename(req.params.fileName || '');
  if (!fileName) {
    return res.status(400).send('Receipt file is required');
  }

  const filePath = path.join(receiptDir, fileName);
  const resolvedReceiptDir = path.resolve(receiptDir);
  const resolvedFilePath = path.resolve(filePath);
  if (!resolvedFilePath.startsWith(resolvedReceiptDir + path.sep) || !fs.existsSync(resolvedFilePath)) {
    return res.status(404).send('Receipt not found');
  }

  return res.sendFile(resolvedFilePath);
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
      RETURNING id, pick_up_late_payment_receipt
    `, [studentName, eventDate, recordTimestamp]);

    if (!result.rowCount) {
      return res.status(404).send('Record not found');
    }

    deleteLatePickUpReceipt(result.rows[0].pick_up_late_payment_receipt);
    return res.json({ deleted: true });
  }

  const records = await readRecords();
  const deletedRecord = records.find((record) => (
    record.studentName === studentName
    && record.eventDate === eventDate
    && record.dropOffTimestamp === recordTimestamp
  ));
  const remaining = records.filter((record) => !(
    record.studentName === studentName
    && record.eventDate === eventDate
    && record.dropOffTimestamp === recordTimestamp
  ));
  if (remaining.length === records.length) {
    return res.status(404).send('Record not found');
  }

  deleteLatePickUpReceipt(deletedRecord?.pickUpLatePaymentReceipt);
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
  await checkAndSendDailyReport();
  await checkAndSendMonthlyReport();
  setInterval(checkAndSendPasswordReminder, 24 * 60 * 60 * 1000);
  setInterval(checkAndSendDailyReport, 5 * 60 * 1000);
  setInterval(checkAndSendMonthlyReport, 24 * 60 * 60 * 1000);
});
