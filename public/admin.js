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
      records.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      currentRecords = records;

      let html = "";
      records.forEach((record, index) => {
        html += `
          <tr>
            <td>${escapeHtml(record.studentName)} / ${escapeHtml(record.parentName)}</td>
            <td>${escapeHtml(record.arrivalDate || formatDate(record.timestamp))}</td>
            <td>${escapeHtml(record.arrivalTime || formatTime(record.timestamp))}</td>
            <td><button type="button" onclick="deleteRecord(${index})">Delete</button></td>
          </tr>
        `;
      });

      if (!html) {
        html = "<tr><td colspan=\"4\">No records yet.</td></tr>";
      }

      document.getElementById("data").innerHTML = html;
    })
    .catch(error => {
      console.error('Attendance load error:', error);
      document.getElementById("data").innerHTML = `<tr><td colspan=\"4\">Unable to load attendance: ${escapeHtml(error.message)}</td></tr>`;
    });
}

function deleteRecord(index) {
  const record = currentRecords[index];
  if (!record || !authenticated || !authHeader) {
    return alert('Unable to delete record. Please log in again.');
  }

  if (!confirm(`Delete attendance record for ${record.studentName} / ${record.parentName}?`)) {
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
  let csv = "Name,Arrival Date,Arrival Time\n";

  rows.forEach(row => {
    if (row.style.display !== "none" && row.cells.length >= 3) {
      const name = row.cells[0].innerText.replace(/"/g, '""');
      const arrivalDate = row.cells[1].innerText.replace(/"/g, '""');
      const arrivalTime = row.cells[2].innerText.replace(/"/g, '""');
      csv += `"${name}","${arrivalDate}","${arrivalTime}"\n`;
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
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString(undefined, { timeZone: ARRIVAL_TIME_ZONE });
}
