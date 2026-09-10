let authHeader = null;
let forcePasswordChange = false;
let currentProfile = null;

window.addEventListener('DOMContentLoaded', initAccountPage);

function initAccountPage() {
  const storedAuthHeader = localStorage.getItem('eventCheckinAdminAuthHeader');
  const params = new URLSearchParams(window.location.search);
  forcePasswordChange = params.get('force') === 'true';

  if (!storedAuthHeader) {
    return;
  }

  authHeader = storedAuthHeader;
  checkAdminSession()
    .then((profile) => {
      showAccountPage(profile);
    })
    .catch(() => {
      localStorage.removeItem('eventCheckinAdminAuthHeader');
      authHeader = null;
    });
}

function login() {
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;

  if (!username || !password) {
    showError('Username and password are required.');
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
      authHeader = `Basic ${btoa(`${username}:${password}`)}`;
      localStorage.setItem('eventCheckinAdminAuthHeader', authHeader);
      forcePasswordChange = profile.passwordChangeRequired === true;
      showAccountPage(profile);
    })
    .catch((error) => {
      showError(error.message);
    });
}

function goBack() {
  window.location.href = '/admin';
}

function logout() {
  authHeader = null;
  localStorage.removeItem('eventCheckinAdminAuthHeader');
  document.getElementById('accountPage').style.display = 'none';
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

function showAccountPage(profile) {
  document.getElementById('loginBox').style.display = 'none';
  document.getElementById('accountPage').style.display = 'block';
  currentProfile = profile;
  document.getElementById('profileUsername').value = profile.username;
  document.getElementById('profileEmail').value = profile.email;
  const reportEmailsToggle = document.getElementById('reportEmailsEnabled');
  reportEmailsToggle.checked = profile.reportEmailsEnabled === true;
  reportEmailsToggle.disabled = profile.reportEmailsConfigured !== true;
  document.getElementById('reportEmailsStatus').innerText = reportEmailsToggle.checked ? 'ON' : 'OFF';
  document.getElementById('reportEmailsNote').innerText = profile.reportEmailsConfigured === true
    ? 'Report emails are controlled by the server configuration.'
    : 'Report emails are disabled by the server configuration.';
  reportEmailsToggle.onchange = toggleReportEmails;
  document.getElementById('reportRecipient').value = '';
  document.getElementById('sendReportButton').disabled = profile.reportEmailsEnabled !== true;
  document.getElementById('reportSendMessage').innerText = '';
  document.getElementById('profilePassword').value = '';
  document.getElementById('profileMessage').innerText = '';

  const banner = document.getElementById('passwordReminderBanner');
  if (forcePasswordChange || profile.passwordChangeRequired) {
    banner.style.display = 'block';
    banner.innerText = 'Your password reminder is active. Please change your password before continuing.';
  } else {
    banner.style.display = 'none';
  }
}

function toggleReportEmails() {
  const enabled = document.getElementById('reportEmailsEnabled').checked;
  fetch('/api/admin/report-email-settings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader,
    },
    body: JSON.stringify({ reportEmailsEnabled: enabled }),
  })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(await response.text() || 'Unable to update report email settings');
      }
      return response.json();
    })
    .then((settings) => {
      currentProfile.reportEmailsEnabled = settings.reportEmailsEnabled === true;
      document.getElementById('reportEmailsEnabled').checked = currentProfile.reportEmailsEnabled;
      document.getElementById('reportEmailsStatus').innerText = currentProfile.reportEmailsEnabled ? 'ON' : 'OFF';
      document.getElementById('sendReportButton').disabled = !currentProfile.reportEmailsEnabled;
      showMessage('Report email setting updated.', false);
    })
    .catch((error) => {
      showMessage(error.message, true);
      showAccountPage(currentProfile);
    });
}

function sendReportByEmail() {
  const recipient = document.getElementById('reportRecipient').value.trim();
  const reportType = document.getElementById('reportType').value;
  const button = document.getElementById('sendReportButton');
  const message = document.getElementById('reportSendMessage');

  if (!recipient) {
    message.innerText = 'Enter an employee email address.';
    message.style.color = '#b91c1c';
    return;
  }

  button.disabled = true;
  message.innerText = 'Sending report...';
  message.style.color = '';
  fetch('/api/admin/send-report', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader,
    },
    body: JSON.stringify({ recipient, reportType }),
  })
    .then(async (response) => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || 'Unable to send the report.');
      }
      return data;
    })
    .then((data) => {
      message.innerText = data.message || 'Report sent.';
      message.style.color = '#166534';
    })
    .catch((error) => {
      message.innerText = error.message;
      message.style.color = '#b91c1c';
    })
    .finally(() => {
      button.disabled = false;
    });
}

function saveProfile() {
  const username = document.getElementById('profileUsername').value.trim();
  const email = document.getElementById('profileEmail').value.trim();
  const password = document.getElementById('profilePassword').value;
  const passwordConfirm = document.getElementById('profilePasswordConfirm').value;

  if (!username || !password || !email) {
    showMessage('Username, password, and email are required.', true);
    return;
  }

  if (password !== passwordConfirm) {
    showMessage('Passwords do not match.', true);
    return;
  }

  fetch('/api/admin/profile', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader,
    },
    body: JSON.stringify({ username, password, email }),
  })
    .then(async (response) => {
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || 'Unable to save admin account');
      }
      return response.json();
    })
    .then((profile) => {
      authHeader = `Basic ${btoa(`${username}:${password}`)}`;
      localStorage.setItem('eventCheckinAdminAuthHeader', authHeader);
      forcePasswordChange = false;
      showAccountPage(profile);
      showMessage('Admin account updated successfully.', false);
      window.location.href = '/admin';
    })
    .catch((error) => {
      showMessage(error.message, true);
    });
}

function showError(message) {
  const errorEl = document.getElementById('error');
  errorEl.innerText = message;
}

function showMessage(message, isError) {
  const messageEl = document.getElementById('profileMessage');
  messageEl.innerText = message;
  messageEl.style.color = isError ? 'red' : 'green';
}
