let authenticated = false;
let authHeader = null;
let currentRecords = [];
let currentProfile = null;
const ARRIVAL_TIME_ZONE = 'America/New_York';

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
  document.getElementById("adminToolbar").style.display = "flex";
  document.getElementById("recordsSection").style.display = "block";
  loadProfile();
  loadScheduleSettings();
  loadData();
}

function hideDashboard() {
  document.getElementById("loginBox").style.display = "block";
  document.getElementById("dashboard").style.display = "none";
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
  document.getElementById("search").value = "";
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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


function loadData() {
  document.getElementById("data").innerHTML = "";

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
      records.sort((a, b) => new Date(getSortTimestamp(b)) - new Date(getSortTimestamp(a)));
      currentRecords = records;

      let html = "";
      records.forEach((record, index) => {
        html += `
          <tr>
            <td>${escapeHtml(record.studentName)}</td>
            <td><span class="status ${escapeHtml(getStatusClass(record.status))}">${escapeHtml(record.status || getRecordStatus(record))}</span></td>
            <td>${formatTimingFlags(record.timingFlags)}</td>
            <td>${escapeHtml(record.eventDate || record.arrivalDate || formatDate(record.dropOffTimestamp || record.timestamp))}</td>
            <td>${escapeHtml(formatPersonTime(record.dropOffParentName || record.parentName, record.dropOffTime || record.arrivalTime, record.dropOffTimestamp || record.timestamp))}</td>
            <td>${escapeHtml(formatPersonTime(record.pickUpParentName, record.pickUpTime, record.pickUpTimestamp))}</td>
            <td><button type="button" onclick="deleteRecord(${index})">Delete</button></td>
          </tr>
        `;
      });

      if (!html) {
        html = "<tr><td colspan=\"7\">No records yet.</td></tr>";
      }

      document.getElementById("data").innerHTML = html;
      renderLateReasonsReport(records);
    })
    .catch(error => {
      console.error('Attendance load error:', error);
      document.getElementById("data").innerHTML = `<tr><td colspan=\"7\">Unable to load attendance: ${escapeHtml(error.message)}</td></tr>`;
      document.getElementById("lateReasonsReport").innerHTML = "";
    });
}

function deleteRecord(index) {
  const record = currentRecords[index];
  if (!record || !authenticated || !authHeader) {
    return alert('Unable to delete record. Please log in again.');
  }

  if (!confirm(`Delete attendance record for ${record.studentName} on ${record.eventDate || record.arrivalDate}?`)) {
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

// SEARCH/FILTER
function filterTable() {
  const input = document.getElementById("search").value.toLowerCase();
  const rows = document.querySelectorAll("#data tr");

  rows.forEach(row => {
    const text = Array.from(row.cells).map(cell => cell.innerText.toLowerCase()).join(" ");
    row.style.display = text.includes(input) ? "" : "none";
  });
}

// EXPORT TO CSV
function exportCSV() {
  const rows = document.querySelectorAll("#data tr");
  let csv = "Student,Status,Late Labels,Event Date,Drop-off,Pick-up\n";

  rows.forEach(row => {
    if (row.style.display !== "none" && row.cells.length >= 6) {
      const student = row.cells[0].innerText.replace(/"/g, '""');
      const status = row.cells[1].innerText.replace(/"/g, '""');
      const lateLabels = row.cells[2].innerText.replace(/"/g, '""');
      const eventDate = row.cells[3].innerText.replace(/"/g, '""');
      const dropOff = row.cells[4].innerText.replace(/"/g, '""');
      const pickUp = row.cells[5].innerText.replace(/"/g, '""');
      csv += `"${student}","${status}","${lateLabels}","${eventDate}","${dropOff}","${pickUp}"\n`;
    }
  });

  // Download CSV
  const blob = new Blob([csv], { type: "text/csv" });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `attendance_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  window.URL.revokeObjectURL(url);
}

// PRINT
function printPage() {
  window.print();
}

function formatDate(timestamp) {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { timeZone: ARRIVAL_TIME_ZONE });
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString(undefined, {
    timeZone: ARRIVAL_TIME_ZONE,
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatStoredTime(arrivalTime) {
  const match = String(arrivalTime || '').match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!match) {
    return arrivalTime || '';
  }

  const hours = Number(match[1]);
  const minutes = match[2];
  if (Number.isNaN(hours) || hours < 0 || hours > 23) {
    return arrivalTime;
  }

  const period = hours >= 12 ? 'PM' : 'AM';
  const displayHours = hours % 12 || 12;
  return `${displayHours}:${minutes} ${period}`;
}

function formatArrivalTime(record) {
  return formatStoredTime(record.arrivalTime) || formatTime(record.timestamp);
}

function getSortTimestamp(record) {
  return record.pickUpTimestamp || record.dropOffTimestamp || record.timestamp || 0;
}

function getRecordStatus(record) {
  if (record.pickUpTimestamp) {
    return 'Picked up';
  }

  if (record.dropOffTimestamp || record.timestamp) {
    return 'Present';
  }

  return 'Not arrived';
}

function getStatusClass(status) {
  const normalized = String(status || '').toLowerCase().replace(/\s+/g, '-');
  return normalized || 'not-arrived';
}

function formatPersonTime(personName, storedTime, timestamp) {
  const time = formatStoredTime(storedTime) || formatTime(timestamp);
  if (!personName && !time) {
    return '';
  }

  if (!personName) {
    return time;
  }

  if (!time) {
    return personName;
  }

  return `${personName} at ${time}`;
}

function loadScheduleSettings() {
  fetch('/api/admin/schedule-settings', { headers: { Authorization: authHeader } })
    .then(async (response) => {
      if (!response.ok) {
        const errorText = await response.text();
        if (response.status === 401 || response.status === 403) {
          logout();
        }
        throw new Error(errorText || 'Unable to load late cutoff times');
      }
      return response.json();
    })
    .then((settings) => {
      document.getElementById("lateDropOffAfter").value = settings.lateDropOffAfter || "08:36";
      document.getElementById("latePickUpAfter").value = settings.latePickUpAfter || "13:35";
    })
    .catch((error) => {
      console.error('Schedule settings load error:', error);
      document.getElementById("settingsMessage").innerText = error.message;
    });
}

function saveScheduleSettings() {
  const lateDropOffAfter = document.getElementById("lateDropOffAfter").value;
  const latePickUpAfter = document.getElementById("latePickUpAfter").value;
  const message = document.getElementById("settingsMessage");
  message.innerText = "Saving...";

  fetch('/api/admin/schedule-settings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader,
    },
    body: JSON.stringify({ lateDropOffAfter, latePickUpAfter }),
  })
    .then(async (response) => {
      if (!response.ok) {
        const error = await response.json().catch(async () => ({ error: await response.text() }));
        if (response.status === 401 || response.status === 403) {
          logout();
        }
        throw new Error(error.error || 'Unable to save late cutoff times');
      }
      return response.json();
    })
    .then(() => {
      message.innerText = "Saved";
      loadData();
    })
    .catch((error) => {
      console.error('Schedule settings save error:', error);
      message.innerText = error.message;
    });
}

function formatTimingFlags(flags) {
  if (!Array.isArray(flags) || flags.length === 0) {
    return '';
  }

  return flags.map((flag) => (
    `<span class="timing-flag ${escapeHtml(getTimingFlagClass(flag))}">${escapeHtml(flag)}</span>`
  )).join(' ');
}

function getTimingFlagClass(flag) {
  return String(flag || '').toLowerCase().replace(/\s+/g, '-');
}

function renderLateReasonsReport(records) {
  const lateEntries = [];

  records.forEach((record) => {
    if (record.dropOffLateReason) {
      lateEntries.push({
        studentName: record.studentName,
        label: 'Late Drop-off',
        eventDate: record.eventDate || record.arrivalDate || '',
        parentName: record.dropOffParentName || record.parentName || '',
        time: formatStoredTime(record.dropOffTime || record.arrivalTime) || formatTime(record.dropOffTimestamp || record.timestamp),
        reason: record.dropOffLateReason,
      });
    }

    if (record.pickUpLateReason) {
      lateEntries.push({
        studentName: record.studentName,
        label: 'Late Pick-up',
        eventDate: record.eventDate || record.arrivalDate || '',
        parentName: record.pickUpParentName || '',
        time: formatStoredTime(record.pickUpTime) || formatTime(record.pickUpTimestamp),
        reason: record.pickUpLateReason,
      });
    }
  });

  const report = document.getElementById("lateReasonsReport");
  if (!lateEntries.length) {
    report.innerHTML = "";
    return;
  }

  report.innerHTML = `
    <h2>Late Reasons</h2>
    ${lateEntries.map((entry) => `
      <div class="late-reason-entry">
        <h3>${escapeHtml(entry.label)} - ${escapeHtml(entry.studentName)}</h3>
        <p><strong>Date:</strong> ${escapeHtml(entry.eventDate)}</p>
        <p><strong>Time:</strong> ${escapeHtml(entry.time)}</p>
        <p><strong>Parent:</strong> ${escapeHtml(entry.parentName)}</p>
        <p><strong>Reason:</strong> ${escapeHtml(entry.reason)}</p>
      </div>
    `).join('')}
  `;
}
