let authenticated = false;
let authHeader = null;
let currentRecords = [];
let currentProfile = null;
let currentScheduleSettings = null;

let activeTab = 'today';
let autoRefreshTimer = null;

window.addEventListener('DOMContentLoaded', initAdmin);

function initAdmin() {
  const storedAuthHeader = localStorage.getItem('eventCheckinAdminAuthHeader');
  if (!storedAuthHeader) {
    return;
  }

  authHeader = storedAuthHeader;
  checkAdminSession()
    .then((profile) => {
      authenticated = true;
      if (profile.passwordChangeRequired) {
        window.location.href = '/admin/account?force=true';
      } else {
        showDashboard();
      }
    })
    .catch(() => {
      localStorage.removeItem('eventCheckinAdminAuthHeader');
      authHeader = null;
    });
}

function showDashboard() {
  document.getElementById("loginBox").style.display = "none";
  document.getElementById("dashboard").style.display = "block";
  document.getElementById("error").innerText = "";
  loadProfile();
  loadScheduleSettings();
  loadPaperSavings();
  loadData();
}

function hideDashboard() {
  document.getElementById("loginBox").style.display = "block";
  document.getElementById("dashboard").style.display = "none";
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
}

function login() {
  const username = document.getElementById("username").value.trim();
  const password = document.getElementById("password").value;

  if (!username || !password) {
    document.getElementById("error").innerText = "Username and password are required.";
    return;
  }

  fetch('/api/admin/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ username, password }),
  })
    .then(async (response) => {
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || 'Invalid username or password.');
      }
      return response.json();
    })
    .then((profile) => {
      authenticated = true;
      authHeader = `Basic ${btoa(`${username}:${password}`)}`;
      localStorage.setItem('eventCheckinAdminAuthHeader', authHeader);
      currentProfile = profile;
      if (profile.passwordChangeRequired) {
        window.location.href = '/admin/account?force=true';
      } else {
        showDashboard();
      }
    })
    .catch((error) => {
      document.getElementById("error").innerText = error.message;
    });
}

function logout() {
  authenticated = false;
  authHeader = null;
  currentRecords = [];
  currentProfile = null;
  currentScheduleSettings = null;
  localStorage.removeItem('eventCheckinAdminAuthHeader');
  hideDashboard();
  document.getElementById("loginBox").style.display = "block";
  document.getElementById("username").value = "";
  document.getElementById("password").value = "";
  document.getElementById("userName").innerText = "";
  const searchEl = document.getElementById("search");
  if (searchEl) searchEl.value = "";
  const filterDateEl = document.getElementById("filterDate");
  if (filterDateEl) filterDateEl.value = "";
  const filterStartDateEl = document.getElementById('filterStartDate');
  if (filterStartDateEl) filterStartDateEl.value = '';
  const filterEndDateEl = document.getElementById('filterEndDate');
  if (filterEndDateEl) filterEndDateEl.value = '';
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getTodayYYYYMMDD() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDisplayDate(dateStr) {
  if (!dateStr) return '';
  const parts = dateStr.split('-');
  if (parts.length === 3) {
    const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
    return d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  }
  return dateStr;
}

function formatTimestampTime(ts) {
  if (!ts) return '';
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function isTodayRecord(record, todayStr) {
  if (record.eventDate && record.eventDate === todayStr) return true;
  const ts = record.dropOffTimestamp || record.timestamp || record.pickUpTimestamp;
  if (ts) {
    const recDateStr = ts.slice(0, 10);
    return recDateStr === todayStr;
  }
  return false;
}

function isLateRecord(record) {
  if (record.dropOffLateReason || record.pickUpLateReason) return true;
  if (Array.isArray(record.timingFlags) && record.timingFlags.length > 0) return true;
  return false;
}

function isPickupRecord(record) {
  return Boolean(record.pickUpParentName || record.pickUpTime || record.pickUpTimestamp);
}

function getRecordDate(record) {
  return record.eventDate || (record.dropOffTimestamp || record.timestamp || record.pickUpTimestamp || '').slice(0, 10);
}

function isEarlyDismissalRecord(record) {
  if (!record.pickUpTimestamp) return false;
  const cutoff = currentScheduleSettings?.latePickUpAfter || '13:35';
  const [cutoffHours, cutoffMinutes] = cutoff.split(':').map(Number);
  const pickupParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(record.pickUpTimestamp));
  const pickupValues = Object.fromEntries(pickupParts.map((part) => [part.type, part.value]));
  const pickupMinutes = (Number(pickupValues.hour) * 60) + Number(pickupValues.minute);
  return Number.isFinite(pickupMinutes) && pickupMinutes < ((cutoffHours * 60) + cutoffMinutes);
}

function isExceptionRecord(record) {
  return isLateRecord(record) || isEarlyDismissalRecord(record);
}

function setActiveTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  if (tab === 'today') document.getElementById('tabToday')?.classList.add('active');
  if (tab === 'all') document.getElementById('tabAll')?.classList.add('active');
  if (tab === 'late') document.getElementById('tabLate')?.classList.add('active');
  if (tab === 'pickups') document.getElementById('tabPickups')?.classList.add('active');
  if (tab === 'earlyDismissals') document.getElementById('tabEarlyDismissals')?.classList.add('active');
  applyFilters();
}

function clearDateFilter() {
  const filterDate = document.getElementById('filterDate');
  if (filterDate) filterDate.value = '';
  const filterStartDate = document.getElementById('filterStartDate');
  if (filterStartDate) filterStartDate.value = '';
  const filterEndDate = document.getElementById('filterEndDate');
  if (filterEndDate) filterEndDate.value = '';
  applyFilters();
}

function toggleAutoRefresh() {
  const enabled = document.getElementById('autoRefreshToggle')?.checked;
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
  if (enabled) {
    autoRefreshTimer = setInterval(() => {
      loadData(true);
    }, 15000);
  }
}

function checkAdminSession() {
  return fetch('/api/admin/profile', { headers: { Authorization: authHeader } })
    .then(async (response) => {
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || 'Session invalid');
      }
      return response.json();
    })
    .then((profile) => {
      currentProfile = profile;
      return profile;
    });
}

function loadProfile() {
  fetch('/api/admin/profile', { headers: { Authorization: authHeader } })
    .then(async (response) => {
      if (!response.ok) {
        const errorText = await response.text();
        if (response.status === 401 || response.status === 403) {
          logout();
        }
        throw new Error(errorText || 'Unable to load profile');
      }
      return response.json();
    })
    .then((profile) => {
      currentProfile = profile;
      document.getElementById("userName").innerText = `Logged in as ${profile.username}`;
      if (profile.passwordChangeRequired) {
        window.location.href = '/admin/account?force=true';
      }
    })
    .catch((error) => {
      console.error('Profile load error:', error);
    });
}

function loadScheduleSettings() {
  fetch('/api/admin/schedule-settings', { headers: { Authorization: authHeader } })
    .then((response) => response.ok ? response.json() : null)
    .then((settings) => {
      currentScheduleSettings = settings;
      applyFilters();
    })
    .catch(() => {
      currentScheduleSettings = null;
    });
}

function updatePaperSavingsSummary(summary) {
  const paperSavingsEl = document.getElementById('paperSavingsSummary');
  if (!paperSavingsEl) return;
  const monthPages = Math.ceil((summary.month || 0) / 28);
  paperSavingsEl.innerText = `Today: ${summary.today || 0} rows avoided. This week: ${summary.week || 0}. This month: ${summary.month || 0} (estimated ${monthPages} page${monthPages === 1 ? '' : 's'} avoided).`;
}

function loadPaperSavings() {
  fetch('/api/admin/paper-savings', { headers: { Authorization: authHeader } })
    .then((response) => response.ok ? response.json() : null)
    .then((summary) => {
      if (summary) updatePaperSavingsSummary(summary);
    })
    .catch(() => {});
}

function loadData(silent = false) {
  if (!silent) {
    const tbody = document.getElementById("data");
    if (tbody && !tbody.children.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:2rem;">Loading attendance records...</td></tr>';
    }
  }

  fetch('/api/records', { headers: { Authorization: authHeader } })
    .then(async (response) => {
      if (!response.ok) {
        const errorText = await response.text();
        if (response.status === 401 || response.status === 403) {
          logout();
        }
        throw new Error(errorText || 'Unable to load attendance');
      }
      return response.json();
    })
    .then(records => {
      records.sort((a, b) => new Date(b.timestamp || b.dropOffTimestamp) - new Date(a.timestamp || a.dropOffTimestamp));
      currentRecords = records;
      applyFilters();
    })
    .catch(error => {
      console.error('Attendance load error:', error);
      if (!silent) {
        document.getElementById("data").innerHTML = `<tr><td colspan="7" style="color:red;text-align:center;">Unable to load attendance: ${escapeHtml(error.message)}</td></tr>`;
      }
    });
}

function deleteRecord(index) {
  const record = currentRecords[index];
  if (!record || !authenticated || !authHeader) {
    return alert('Unable to delete record. Please log in again.');
  }

  if (!confirm(`Delete attendance record for ${record.studentName} / ${record.parentName || record.dropOffParentName}?`)) {
    return;
  }

  fetch('/api/records', {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader,
    },
    body: JSON.stringify(record),
  })
    .then(async (response) => {
      if (!response.ok) {
        const errorText = await response.text();
        if (response.status === 401 || response.status === 403) {
          logout();
        }
        throw new Error(errorText || 'Unable to delete record');
      }
      return response.json();
    })
    .then(() => {
      loadData();
    })
    .catch(error => {
      console.error('Delete record error:', error);
      alert(`Could not delete record: ${error.message}`);
    });
}

function recordMatchesFilters(record, includeExceptionsFilter = true) {
  const todayStr = getTodayYYYYMMDD();
  const searchInput = (document.getElementById("search")?.value || "").toLowerCase().trim();
  const filterDateVal = document.getElementById("filterDate")?.value || "";
  const filterStartDateVal = document.getElementById('filterStartDate')?.value || '';
  const filterEndDateVal = document.getElementById('filterEndDate')?.value || '';
  const exceptionsOnly = document.getElementById('exceptionsOnly')?.checked;

  if (activeTab === 'today' && !isTodayRecord(record, todayStr)) return false;
  if (activeTab === 'late' && !isLateRecord(record)) return false;
  if (activeTab === 'pickups' && !isPickupRecord(record)) return false;
  if (activeTab === 'earlyDismissals' && !isEarlyDismissalRecord(record)) return false;
  if (includeExceptionsFilter && exceptionsOnly && !isExceptionRecord(record)) return false;

  const recDate = getRecordDate(record);
  if (filterDateVal && recDate !== filterDateVal) return false;
  if (filterStartDateVal && recDate < filterStartDateVal) return false;
  if (filterEndDateVal && recDate > filterEndDateVal) return false;

  if (searchInput) {
    const student = (record.studentName || '').toLowerCase();
    const parentDrop = (record.dropOffParentName || record.parentName || '').toLowerCase();
    const parentPick = (record.pickUpParentName || '').toLowerCase();
    const lateReason = `${record.dropOffLateReason || ''} ${record.pickUpLateReason || ''}`.toLowerCase();
    const matches = student.includes(searchInput)
      || parentDrop.includes(searchInput)
      || parentPick.includes(searchInput)
      || lateReason.includes(searchInput);
    if (!matches) return false;
  }

  return true;
}

function getFilteredRecords() {
  return currentRecords.filter((record) => recordMatchesFilters(record));
}

function setReportScope(exceptionsOnly) {
  const exceptionsCheckbox = document.getElementById('exceptionsOnly');
  if (exceptionsCheckbox) exceptionsCheckbox.checked = exceptionsOnly;
  applyFilters();
}

function updateSummaryMetrics(records, summaryRecords = records) {
  const todayStr = getTodayYYYYMMDD();
  const filterDateVal = document.getElementById("filterDate")?.value || "";
  const filterStartDateVal = document.getElementById('filterStartDate')?.value || '';
  const filterEndDateVal = document.getElementById('filterEndDate')?.value || '';

  const activeDate = filterDateVal || (activeTab === 'today' ? todayStr : '');
  const dateBadgeEl = document.getElementById("summaryDateBadge");
  const summaryTitleEl = document.getElementById("summaryTitle");

  if (activeDate) {
    if (dateBadgeEl) dateBadgeEl.innerText = formatDisplayDate(activeDate);
    if (summaryTitleEl) summaryTitleEl.innerText = activeDate === todayStr ? "Today's Attendance Summary" : `Attendance Summary (${activeDate})`;
  } else {
    const dateRange = [filterStartDateVal, filterEndDateVal].filter(Boolean).join(' to ');
    if (dateBadgeEl) dateBadgeEl.innerText = dateRange || "All Time Records";
    if (summaryTitleEl) summaryTitleEl.innerText = dateRange ? 'Attendance Summary' : "Overall Attendance Summary";
  }

  let total = summaryRecords.length;
  let lateCount = 0;
  let pickupsCount = 0;
  let earlyDismissalsCount = 0;

  summaryRecords.forEach(r => {
    if (isLateRecord(r)) lateCount++;
    if (isPickupRecord(r)) pickupsCount++;
    if (isEarlyDismissalRecord(r)) earlyDismissalsCount++;
  });

  let onTimeCount = Math.max(0, total - lateCount);

  const totalEl = document.getElementById("statTotal");
  const onTimeEl = document.getElementById("statOnTime");
  const lateEl = document.getElementById("statLate");
  const pickupsEl = document.getElementById("statPickups");
  const earlyDismissalsEl = document.getElementById('statEarlyDismissals');
  const visibleCountEl = document.getElementById("visibleCount");

  if (totalEl) totalEl.innerText = total;
  if (onTimeEl) onTimeEl.innerText = onTimeCount;
  if (lateEl) lateEl.innerText = lateCount;
  if (pickupsEl) pickupsEl.innerText = pickupsCount;
  if (earlyDismissalsEl) earlyDismissalsEl.innerText = earlyDismissalsCount;
  if (visibleCountEl) visibleCountEl.innerText = records.length;

  const reportSummaryEl = document.getElementById('reportSummary');
  const paperSavingSummaryEl = document.getElementById('paperSavingSummary');
  if (reportSummaryEl) {
    const reportDate = activeDate ? formatDisplayDate(activeDate) : (filterStartDateVal || filterEndDateVal ? 'Selected date range' : 'All attendance records');
    reportSummaryEl.innerText = `Daily Report - ${reportDate}: ${total} check-ins, ${lateCount} late, ${earlyDismissalsCount} early dismissals`;
  }
  if (paperSavingSummaryEl) {
    const fullRecordCount = summaryRecords.length;
    const estimatedPages = records.length === 0 ? 0 : Math.ceil(records.length / 28);
    if (document.getElementById('exceptionsOnly')?.checked) {
      const savedRows = Math.max(0, fullRecordCount - records.length);
      paperSavingSummaryEl.innerText = records.length
        ? `Printing ${records.length} exceptions instead of ${fullRecordCount} total records. Estimated: ${estimatedPages} page${estimatedPages === 1 ? '' : 's'}. Saving approximately ${savedRows} rows.`
        : 'No exceptions match these filters. Nothing needs to be printed.';
    } else {
      paperSavingSummaryEl.innerText = `Printing ${records.length} total records. Estimated: ${estimatedPages} page${estimatedPages === 1 ? '' : 's'}.`;
    }
  }
}

function renderTable(records) {
  const tbody = document.getElementById("data");
  if (!tbody) return;

  if (!records || records.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:1.5rem;color:#64748b;">No records found for the selected filter.</td></tr>';
    return;
  }

  let html = "";
  records.forEach((record) => {
    const originalIndex = currentRecords.indexOf(record);

    // Parent Display
    let parentText = escapeHtml(record.dropOffParentName || record.parentName || '-');
    if (record.pickUpParentName && record.pickUpParentName !== record.dropOffParentName) {
      parentText += `<br><span class="parent-subtext">Pick-up: ${escapeHtml(record.pickUpParentName)}</span>`;
    }

    // Drop-off formatting
    let dropOffCell = '-';
    if (record.dropOffTime || record.dropOffTimestamp) {
      const isLate = Boolean(record.dropOffLateReason || (record.timingFlags && record.timingFlags.includes('Late Drop-off')));
      const badge = isLate
        ? '<span class="badge badge-warning">Late</span>'
        : '<span class="badge badge-success">On time</span>';
      const timeStr = escapeHtml(record.dropOffTime || formatTimestampTime(record.dropOffTimestamp));
      dropOffCell = `${timeStr} ${badge}`;
    }

    // Pick-up formatting
    let pickUpCell = '-';
    if (record.pickUpTime || record.pickUpTimestamp) {
      const isLate = Boolean(record.pickUpLateReason || (record.timingFlags && record.timingFlags.includes('Late Pick-up')));
      const badge = isLate
        ? '<span class="badge badge-warning">Late</span>'
        : '<span class="badge badge-info">Picked up</span>';
      const timeStr = escapeHtml(record.pickUpTime || formatTimestampTime(record.pickUpTimestamp));
      pickUpCell = `${timeStr} ${badge}`;
    }

    // Late Reasons
    const lateReasons = [
      record.dropOffLateReason ? `<strong>Drop-off:</strong> ${escapeHtml(record.dropOffLateReason)}` : '',
      record.pickUpLateReason ? `<strong>Pick-up:</strong> ${escapeHtml(record.pickUpLateReason)}` : '',
    ].filter(Boolean).join('<br>') || '<span style="color:#94a3b8;">None</span>';

    // Status Badge
    let statusBadge = '<span class="badge badge-success">Checked in</span>';
    if (isEarlyDismissalRecord(record)) {
      statusBadge = '<span class="badge badge-warning">Early dismissal</span>';
    } else if (isPickupRecord(record)) {
      statusBadge = '<span class="badge badge-info">Completed</span>';
    } else if (isLateRecord(record)) {
      statusBadge = '<span class="badge badge-warning">Late Drop-off</span>';
    }

    html += `
      <tr>
        <td><strong>${escapeHtml(record.studentName)}</strong></td>
        <td>${parentText}</td>
        <td>${dropOffCell}</td>
        <td>${pickUpCell}</td>
        <td>${lateReasons}</td>
        <td>${statusBadge}</td>
        <td class="actions-column"><button type="button" class="btn-delete" onclick="deleteRecord(${originalIndex})">Delete</button></td>
      </tr>
    `;
  });

  tbody.innerHTML = html;
}

function applyFilters() {
  const filtered = getFilteredRecords();
  const summaryRecords = currentRecords.filter((record) => recordMatchesFilters(record, false));
  updateSummaryMetrics(filtered, summaryRecords);
  renderTable(filtered);
}

function exportCSV() {
  const recordsToExport = getFilteredRecords();
  if (!recordsToExport.length) {
    alert("No records to export.");
    return;
  }

  // Export clean individual columns so Excel opens every field in its OWN box/column!
  const headers = [
    "Student Name",
    "Event Date",
    "Drop-off Parent",
    "Drop-off Time",
    "Drop-off Status",
    "Drop-off Late Reason",
    "Pick-up Parent",
    "Pick-up Time",
    "Pick-up Status",
    "Pick-up Late Reason"
  ];

  const sanitizeCell = (value) => String(value || '')
    .replace(/\r?\n|\r/g, ' ')
    .replace(/\t/g, ' ');
  let csvContent = `\uFEFF${headers.map(sanitizeCell).join('\t')}\n`;

  recordsToExport.forEach(r => {
    const dropOffStatus = r.dropOffLateReason || (r.timingFlags && r.timingFlags.includes('Late Drop-off')) ? "Late" : (r.dropOffTime ? "On time" : "");
    const pickUpStatus = r.pickUpLateReason || (r.timingFlags && r.timingFlags.includes('Late Pick-up')) ? "Late" : (r.pickUpTime ? "Picked up" : "");

    const rowValues = [
      r.studentName || '',
      r.eventDate || '',
      r.dropOffParentName || r.parentName || '',
      r.dropOffTime || '',
      dropOffStatus,
      r.dropOffLateReason || '',
      r.pickUpParentName || '',
      r.pickUpTime || '',
      pickUpStatus,
      r.pickUpLateReason || ''
    ];

    csvContent += rowValues.map(sanitizeCell).join('\t') + "\n";
  });

  const activeDate = document.getElementById("filterDate")?.value
    || document.getElementById('filterStartDate')?.value
    || (activeTab === 'today' ? getTodayYYYYMMDD() : 'all');
  const filename = `attendance_report_${activeDate}.tsv`;

  const blob = new Blob([csvContent], { type: 'text/tab-separated-values;charset=utf-8;' });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.URL.revokeObjectURL(url);
}

function printCurrentReport() {
  const recordsToPrint = getFilteredRecords();
  if (!recordsToPrint.length) {
    alert('There are no records in this report to print. Choose Full Report or change the filters.');
    return;
  }
  const printKey = [
    activeTab,
    document.getElementById('filterDate')?.value || '',
    document.getElementById('filterStartDate')?.value || '',
    document.getElementById('filterEndDate')?.value || '',
    document.getElementById('exceptionsOnly')?.checked || false,
  ].join(':');
  const recordVersion = recordsToPrint.map((record) => [
    record.studentName,
    record.eventDate,
    record.dropOffTimestamp || record.timestamp,
    record.pickUpTimestamp,
    record.dropOffLateReason,
    record.pickUpLateReason,
  ].join('|')).sort().join('~');
  const storageKey = `eventCheckinPrintedReport:${getTodayYYYYMMDD()}:${printKey}:${recordVersion}`;
  if (localStorage.getItem(storageKey) && !confirm('This report was already printed today with the same filters and records. Print another copy?')) {
    return;
  }
  localStorage.setItem(storageKey, 'true');
  if (document.getElementById('exceptionsOnly')?.checked) {
    const fullRecordCount = currentRecords.filter((record) => recordMatchesFilters(record, false)).length;
    const savedRows = Math.max(0, fullRecordCount - recordsToPrint.length);
    if (savedRows > 0) {
      fetch('/api/admin/paper-savings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: authHeader },
        body: JSON.stringify({ reportId: storageKey, savedRows }),
      })
        .then((response) => response.ok ? response.json() : null)
        .then((summary) => { if (summary) updatePaperSavingsSummary(summary); })
        .catch(() => {});
    }
  }
  window.print();
}

function printReportWithScope(exceptionsOnly) {
  setReportScope(exceptionsOnly);
  printCurrentReport();
}

function downloadPdfReport() {
  alert('In the print window, choose "Save as PDF" as the printer destination. The compact report will be saved without opening Excel.');
  printCurrentReport();
}

function emailDailyReport() {
  const recordsToEmail = getFilteredRecords();
  if (!recordsToEmail.length) {
    alert('There are no records in this report to email. Choose Full Report or change the filters.');
    return;
  }
  const button = document.getElementById('emailReportBtn');
  if (button) button.disabled = true;

  fetch('/api/admin/daily-report/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader,
    },
    body: JSON.stringify({ records: recordsToEmail }),
  })
    .then(async (response) => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Unable to email the daily report.');
      return data;
    })
    .then((data) => alert(data.message || 'Daily report sent.'))
    .catch((error) => alert(error.message))
    .finally(() => {
      if (button) button.disabled = false;
    });
}

function printPage() {
  window.print();
}
