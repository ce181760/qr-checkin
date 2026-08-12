let authHeader = null;

window.addEventListener('DOMContentLoaded', initSenderSettingsPage);

function initSenderSettingsPage() {
  const storedAuthHeader = localStorage.getItem('eventCheckinAdminAuthHeader');
  if (!storedAuthHeader) {
    return;
  }

  authHeader = storedAuthHeader;
  checkAdminSession()
    .then(() => {
      showSenderSettingsPage();
      loadSenderSettings();
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
      showSenderSettingsPage();
      loadSenderSettings();
    })
    .catch((error) => {
      showError(error.message);
    });
}

function logout() {
  authHeader = null;
  localStorage.removeItem('eventCheckinAdminAuthHeader');
  document.getElementById('senderSettingsPage').style.display = 'none';
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

function showSenderSettingsPage() {
  document.getElementById('loginBox').style.display = 'none';
  document.getElementById('senderSettingsPage').style.display = 'block';
  document.getElementById('senderSettingsMessage').innerText = '';
  document.getElementById('dailyReportSettingsMessage').innerText = '';
}

function loadSenderSettings() {
  fetch('/api/admin/sender-settings', { headers: { Authorization: authHeader } })
    .then(async (response) => {
      if (!response.ok) {
        const error = await parseResponseBody(response);
        if (response.status === 401 || response.status === 403) {
          logout();
        }
        throw new Error(error.error || 'Unable to load sender settings');
      }
      return response.json();
    })
    .then((settings) => {
      document.getElementById('senderName').value = settings.senderName || 'Event Check-In';
      document.getElementById('senderEmail').value = settings.senderEmail || '';
      document.getElementById('senderAppPassword').value = '';
      document.getElementById('senderAppPassword').placeholder = settings.hasSenderAppPassword
        ? 'Saved. Enter a new app password to replace it.'
        : 'Gmail app password';
      document.getElementById('senderAppPassword').required = !settings.hasSenderAppPassword;
      loadDailyReportSettings(settings.dailyReportSettings || {});
    })
    .catch((error) => {
      showMessage('senderSettingsMessage', error.message, true);
    });
}

function saveSenderSettings() {
  const senderName = document.getElementById('senderName').value.trim();
  const senderEmail = document.getElementById('senderEmail').value.trim();
  const senderAppPassword = document.getElementById('senderAppPassword').value.trim();
  showMessage('senderSettingsMessage', 'Saving...', false);

  fetch('/api/admin/sender-settings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader,
    },
    body: JSON.stringify({ senderName, senderEmail, senderAppPassword }),
  })
    .then(async (response) => {
      const data = await parseResponseBody(response);
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          logout();
        }
        throw new Error(data.error || 'Unable to save sender settings');
      }
      return data;
    })
    .then((settings) => {
      document.getElementById('senderName').value = settings.senderName || senderName;
      document.getElementById('senderEmail').value = settings.senderEmail || senderEmail;
      document.getElementById('senderAppPassword').value = '';
      document.getElementById('senderAppPassword').placeholder = 'Saved. Enter a new app password to replace it.';
      document.getElementById('senderAppPassword').required = false;
      showMessage('senderSettingsMessage', 'Sender settings saved.', false);
    })
    .catch((error) => {
      showMessage('senderSettingsMessage', error.message, true);
    });
}

function saveDailyReportSettings() {
  const dailyReportSettings = getDailyReportSettings();
  showMessage('dailyReportSettingsMessage', 'Saving...', false);

  saveDailyReportSettingsRequest('/api/admin/daily-report-settings', { dailyReportSettings })
    .then((settings) => {
      loadDailyReportSettings(settings.dailyReportSettings || dailyReportSettings);
      showMessage('dailyReportSettingsMessage', 'Automatic daily reports saved.', false);
    })
    .catch((error) => {
      showMessage('dailyReportSettingsMessage', error.message, true);
    });
}

function saveDailyReportSettingsRequest(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader,
    },
    body: JSON.stringify(body),
  })
    .then(async (response) => {
      const data = await parseResponseBody(response);
      if (response.status === 404 && url === '/api/admin/daily-report-settings') {
        return saveDailyReportSettingsWithSenderFallback(body.dailyReportSettings);
      }
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          logout();
        }
        throw new Error(data.error || 'Unable to save automatic daily reports');
      }
      return data;
    });
}

function saveDailyReportSettingsWithSenderFallback(dailyReportSettings) {
  return saveDailyReportSettingsRequest('/api/admin/sender-settings', {
    senderName: document.getElementById('senderName').value.trim(),
    senderEmail: document.getElementById('senderEmail').value.trim(),
    senderAppPassword: document.getElementById('senderAppPassword').value.trim(),
    dailyReportSettings,
  });
}

function loadDailyReportSettings(settings) {
  document.getElementById('dailyReportMode').value = settings.reportMode === 'separate' ? 'separate' : 'combined';
  document.getElementById('combinedReportTime').value = settings.combinedReportTime || '18:00';
  document.getElementById('dropOffReportTime').value = settings.dropOffReportTime || '10:30';
  document.getElementById('pickUpReportTime').value = settings.pickUpReportTime || '18:00';
  updateDailyReportModeFields();
}

function getDailyReportSettings() {
  return {
    reportMode: document.getElementById('dailyReportMode').value,
    combinedReportTime: document.getElementById('combinedReportTime').value,
    dropOffReportTime: document.getElementById('dropOffReportTime').value,
    pickUpReportTime: document.getElementById('pickUpReportTime').value,
  };
}

function updateDailyReportModeFields() {
  const isSeparate = document.getElementById('dailyReportMode').value === 'separate';
  document.getElementById('combinedReportTimeField').hidden = isSeparate;
  document.getElementById('dropOffReportTimeField').hidden = !isSeparate;
  document.getElementById('pickUpReportTimeField').hidden = !isSeparate;
}

async function parseResponseBody(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    return { error: text };
  }
}

function showError(message) {
  document.getElementById('error').innerText = message;
}

function showMessage(elementId, message, isError) {
  const messageEl = document.getElementById(elementId);
  messageEl.innerText = message;
  messageEl.style.color = isError ? 'red' : 'green';
}
