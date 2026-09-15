const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { app } = require('../server');

const csvPath = path.join(__dirname, '../data/attendance.csv');
const originalCsv = fs.existsSync(csvPath) ? fs.readFileSync(csvPath, 'utf8') : null;

const exportCsv = [
  'StudentName,EventDate,DropOffParentName,DropOffTime,DropOffTimestamp,DropOffLateReason,PickUpParentName,PickUpTime,PickUpTimestamp,PickUpLateReason,PickUpLatePaymentConfirmed,PickUpLatePaymentReceipt,PickUpLatePaymentMethod',
  'John Smith,2026-09-15,Parent One,8:30 AM,2026-09-15T08:30:00-04:00,,Parent Two,3:14 PM,2026-09-15T15:14:00-04:00,Parent arrived late,true,receipt-1.png,cash',
  'Jane Doe,2026-09-15,Parent Three,8:20 AM,2026-09-15T08:20:00-04:00,,Parent Four,2:55 PM,2026-09-15T14:55:00-04:00,,false,,venmo',
].join('\n') + '\n';

async function fetchExportWorkbook() {
  const server = app.listen(0);
  await once(server, 'listening');

  try {
    const port = server.address().port;
    const auth = Buffer.from('admin:admin123').toString('base64');
    const response = await fetch(`http://127.0.0.1:${port}/api/records/export`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({
        recordKeys: [
          { studentName: 'John Smith', eventDate: '2026-09-15', dropOffTimestamp: '2026-09-15T08:30:00-04:00' },
          { studentName: 'Jane Doe', eventDate: '2026-09-15', dropOffTimestamp: '2026-09-15T08:20:00-04:00' },
        ],
      }),
    });

    assert.equal(response.status, 200, `Expected 200 but got ${response.status}`);
    const workbookBuffer = Buffer.from(await response.arrayBuffer());
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(workbookBuffer);
    return workbook;
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test('export workbook includes explicit late-pickup, payment, and receipt detail columns', async () => {
  fs.writeFileSync(csvPath, exportCsv, 'utf8');

  try {
    const workbook = await fetchExportWorkbook();
    const ws = workbook.getWorksheet('Attendance');
    const headers = ws.getRow(1).values.slice(1);

    assert.deepEqual(headers, [
      'Student Name',
      'Parent / Pickup Parent',
      'Who completed pickup',
      'Date',
      'Drop-Off Time',
      'Pick-Up Time',
      'Status',
      'Pickup Timing',
      'Late Pickup Reason',
      'Payment Confirmed',
      'Payment Method',
      'Receipt Uploaded',
    ]);

    const lateRow = ws.getRow(2).values.slice(1);
    assert.equal(lateRow[0], 'John Smith');
    assert.equal(lateRow[1], 'Parent One');
    assert.equal(lateRow[2], 'Parent Two');
    assert.equal(lateRow[6], 'Complete');
    assert.equal(lateRow[7], 'Late Pick-up');
    assert.equal(lateRow[8], 'Parent arrived late');
    assert.equal(lateRow[9], 'Yes');
    assert.equal(lateRow[10], 'Cash');
    assert.equal(lateRow[11], 'Yes');

    const onTimeRow = ws.getRow(3).values.slice(1);
    assert.equal(onTimeRow[0], 'Jane Doe');
    assert.equal(onTimeRow[7], 'On Time');
    assert.equal(onTimeRow[9], 'No');
    assert.equal(onTimeRow[10], 'Venmo');
    assert.equal(onTimeRow[11], 'No');
  } finally {
    if (originalCsv === null) {
      if (fs.existsSync(csvPath)) fs.unlinkSync(csvPath);
    } else {
      fs.writeFileSync(csvPath, originalCsv, 'utf8');
    }
  }
});
