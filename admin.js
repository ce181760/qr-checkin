let authenticated = false;
let authHeader = null;
let currentRecords = [];
let currentProfile = null;

let activeTab = 'today'; // 'today', 'all', 'late', 'pickups'
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

function setActiveTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  if (tab === 'today') document.getElementById('tabToday')?.classList.add('active');
  if (tab === 'all') document.getElementById('tabAll')?.classList.add('active');
  if (tab === 'late') document.getElementById('tabLate')?.classList.add('active');
  if (tab === 'pickups') document.getElementById('tabPickups')?.classList.add('active');
  applyFilters();
}

function clearDateFilter() {
  const filterDate = document.getElementById('filterDate');
  if (filterDate) filterDate.value = '';
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

function getFilteredRecords() {
  const todayStr = getTodayYYYYMMDD();
  const searchInput = (document.getElementById("search")?.value || "").toLowerCase().trim();
  const filterDateVal = document.getElementById("filterDate")?.value || "";

  return currentRecords.filter(record => {
    // Tab filter
    if (activeTab === 'today' && !isTodayRecord(record, todayStr)) return false;
    if (activeTab === 'late' && !isLateRecord(record)) return false;
    if (activeTab === 'pickups' && !isPickupRecord(record)) return false;

    // Specific Date filter
    if (filterDateVal) {
      const recDate = record.eventDate || (record.dropOffTimestamp || record.timestamp || '').slice(0, 10);
      if (recDate !== filterDateVal) return false;
    }

    // Search filter
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
  });
}

function updateSummaryMetrics(records) {
  const todayStr = getTodayYYYYMMDD();
  const filterDateVal = document.getElementById("filterDate")?.value || "";

  const activeDate = filterDateVal || (activeTab === 'today' ? todayStr : '');
  const dateBadgeEl = document.getElementById("summaryDateBadge");
  const summaryTitleEl = document.getElementById("summaryTitle");

  if (activeDate) {
    if (dateBadgeEl) dateBadgeEl.innerText = formatDisplayDate(activeDate);
    if (summaryTitleEl) summaryTitleEl.innerText = activeDate === todayStr ? "Today's Attendance Summary" : `Attendance Summary (${activeDate})`;
  } else {
    if (dateBadgeEl) dateBadgeEl.innerText = "All Time Records";
    if (summaryTitleEl) summaryTitleEl.innerText = "Overall Attendance Summary";
  }

  let total = records.length;
  let lateCount = 0;
  let pickupsCount = 0;

  records.forEach(r => {
    if (isLateRecord(r)) lateCount++;
    if (isPickupRecord(r)) pickupsCount++;
  });

  let onTimeCount = Math.max(0, total - lateCount);

  const totalEl = document.getElementById("statTotal");
  const onTimeEl = document.getElementById("statOnTime");
  const lateEl = document.getElementById("statLate");
  const pickupsEl = document.getElementById("statPickups");
  const visibleCountEl = document.getElementById("visibleCount");

  if (totalEl) totalEl.innerText = total;
  if (onTimeEl) onTimeEl.innerText = onTimeCount;
  if (lateEl) lateEl.innerText = lateCount;
  if (pickupsEl) pickupsEl.innerText = pickupsCount;
  if (visibleCountEl) visibleCountEl.innerText = total;
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
    if (isPickupRecord(record)) {
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
  updateSummaryMetrics(filtered);
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

  let csvContent = headers.map(h => `"${h}"`).join(',') + "\n";

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

    const escapedRow = rowValues.map(val => {
      const cleanVal = String(val).replace(/\r?\n|\r/g, ' ').replace(/"/g, '""');
      return `"${cleanVal}"`;
    });

    csvContent += escapedRow.join(',') + "\n";
  });

  const activeDate = document.getElementById("filterDate")?.value || (activeTab === 'today' ? getTodayYYYYMMDD() : 'all');
  const filename = `attendance_report_${activeDate}.csv`;

  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.URL.revokeObjectURL(url);
}

function printTodayReport() {
  setActiveTab('today');
  window.print();
}

function printPage() {
  window.print();
}
