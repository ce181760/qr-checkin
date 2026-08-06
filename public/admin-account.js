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
  const identifier = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;

  if (!identifier || !password) {
    showError('Username, email, or phone and password are required.');
    return;
  }

  fetch('/api/admin/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
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
  document.getElementById('profilePhone').value = profile.phone || '';
  document.getElementById('profilePassword').value = '';
  document.getElementById('profileMessage').innerText = '';

  const banner = document.getElementById('passwordReminderBanner');
  if (banner) {
    banner.style.display = 'none';
  }
}

function saveProfile() {
  const username = document.getElementById('profileUsername').value.trim();
  const email = document.getElementById('profileEmail').value.trim();
  const phone = document.getElementById('profilePhone').value.trim();
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

  // Server will validate password reuse; do not expose or compare passwords client-side.

  fetch('/api/admin/profile', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader,
    },
    body: JSON.stringify({ username, password, email, phone }),
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
