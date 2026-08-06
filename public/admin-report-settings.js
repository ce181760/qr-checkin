let authHeader = null;
let reportRecipients = [];
let maxReportRecipients = 12;
const REPORT_REQUEST_TIMEOUT_MS = 15000;

window.addEventListener('DOMContentLoaded', initReportSettingsPage);

function initReportSettingsPage() {
  const storedAuthHeader = localStorage.getItem('eventCheckinAdminAuthHeader');
  if (!storedAuthHeader) {
    return;
  }

  authHeader = storedAuthHeader;
  checkAdminSession()
    .then(() => {
      showReportSettingsPage();
      loadReportSettings();
    })
    .catch(() => {
      localStorage.removeItem('eventCheckinAdminAuthHeader');
      authHeader = null;
    });
}

function login() {
  const identifier = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;

  if (!identifier || !password) {
    showError('Username, email, or phone and password are required.');
    return;
  }

  fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier, password }),
  })
    .then(async (response) => {
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || 'Invalid username or password.');
      }
      return response.json();
    })
    .then((profile) => {
      authHeader = `Basic ${btoa(`${identifier}:${password}`)}`;
      localStorage.setItem('eventCheckinAdminAuthHeader', authHeader);
      showReportSettingsPage();
      loadReportSettings();
    })
    .catch((error) => {
      showError(error.message);
    });
}

function logout() {
  authHeader = null;
  localStorage.removeItem('eventCheckinAdminAuthHeader');
  document.getElementById('reportSettingsPage').style.display = 'none';
  document.getElementById('loginBox').style.display = 'block';
  document.getElementById('username').value = '';
  document.getElementById('password').value = '';
  document.getElementById('error').innerText = '';
}

function checkAdminSession() {
  return fetch('/api/admin/profile', { headers: { Authorization: authHeader } })
    .then(async (response) => {
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || 'Session invalid');
      }
      return response.json();
    });
}

function showReportSettingsPage() {
  document.getElementById('loginBox').style.display = 'none';
  document.getElementById('reportSettingsPage').style.display = 'block';
  document.getElementById('reportSettingsMessage').innerText = '';
}

function loadReportSettings() {
  fetch('/api/admin/report-settings', { headers: { Authorization: authHeader } })
    .then(async (response) => {
      if (!response.ok) {
        const error = await response.json().catch(async () => ({ error: await response.text() }));
        if (response.status === 401 || response.status === 403) {
          logout();
        }
        throw new Error(error.error || 'Unable to load report receivers');
      }
      return response.json();
    })
    .then((settings) => {
      reportRecipients = Array.isArray(settings.reportRecipients) ? settings.reportRecipients : [];
      maxReportRecipients = settings.maxReportRecipients || 12;
      renderReportReceivers();
    })
    .catch((error) => {
      showMessage(error.message, true);
    });
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function addReportReceiver() {
  const input = document.getElementById('receiverEmail');
  const email = input.value.trim();

  if (!isValidEmail(email)) {
    showMessage('Enter a valid receiver email.', true);
    return;
  }

  if (reportRecipients.length >= maxReportRecipients) {
    showMessage(`You can add up to ${maxReportRecipients} receivers.`, true);
    return;
  }

  if (reportRecipients.some((receiver) => receiver.toLowerCase() === email.toLowerCase())) {
    showMessage('That receiver is already on the list.', true);
    return;
  }

  reportRecipients.push(email);
  input.value = '';
  renderReportReceivers();
  saveReportSettings('Receiver added and saved.');
}

function removeReportReceiver(index) {
  const removedRecipients = [...reportRecipients];
  reportRecipients.splice(index, 1);
  renderReportReceivers();
  saveReportSettings('Receiver removed and saved.')
    .catch(() => {
      reportRecipients = removedRecipients;
      renderReportReceivers();
    });
}

function renderReportReceivers() {
  const list = document.getElementById('receiverList');
  const count = document.getElementById('receiverCount');
  count.innerText = `${reportRecipients.length} of ${maxReportRecipients} receivers`;

  if (!reportRecipients.length) {
    list.innerHTML = '<li>No receivers added.</li>';
    return;
  }

  list.innerHTML = reportRecipients.map((email, index) => `
    <li>
      ${escapeHtml(email)}
      <button type="button" onclick="removeReportReceiver(${index})">Remove</button>
    </li>
  `).join('');
}

function saveReportSettings(successMessage = 'Report receivers saved.') {
  showMessage('Saving...', false);

  return fetch('/api/admin/report-settings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader,
    },
    body: JSON.stringify({ reportRecipients }),
  })
    .then(async (response) => {
      const data = await response.json().catch(async () => ({ error: await response.text() }));
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          logout();
        }
        throw new Error(data.error || 'Unable to save report receivers');
      }
      return data;
    })
    .then((settings) => {
      reportRecipients = Array.isArray(settings.reportRecipients) ? settings.reportRecipients : reportRecipients;
      maxReportRecipients = settings.maxReportRecipients || maxReportRecipients;
      renderReportReceivers();
      showMessage(successMessage, false);
      return settings;
    })
    .catch((error) => {
      showMessage(error.message, true);
      throw error;
    });
}

function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REPORT_REQUEST_TIMEOUT_MS);

  return fetch(url, {
    ...options,
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout));
}

function emailDailyReport() {
  saveReportSettings()
    .then(() => {
      showMessage('Sending daily report...', false);
      return fetchWithTimeout('/api/admin/daily-report/email', {
        method: 'POST',
        headers: { Authorization: authHeader },
      });
    })
    .then(async (response) => {
      const data = await response.json().catch(async () => ({ error: await response.text() }));
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          logout();
        }
        throw new Error(data.error || 'Unable to email daily report');
      }
      return data;
    })
    .then((data) => {
      showMessage(data.message || 'Daily report sent.', false);
    })
    .catch((error) => {
      const message = error.name === 'AbortError'
        ? 'Daily report email timed out. Check your sender settings and try again.'
        : error.message;
      showMessage(message, true);
    });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showError(message) {
  document.getElementById('error').innerText = message;
}

function showMessage(message, isError) {
  const messageEl = document.getElementById('reportSettingsMessage');
  messageEl.innerText = message;
  messageEl.style.color = isError ? 'red' : 'green';
}
