let authHeader = null;

window.addEventListener('DOMContentLoaded', initScheduleSettingsPage);

function initScheduleSettingsPage() {
  authHeader = localStorage.getItem('eventCheckinAdminAuthHeader');
  if (!authHeader) return;
  fetch('/api/admin/schedule-settings', { headers: { Authorization: authHeader } })
    .then(async (response) => {
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    })
    .then((settings) => {
      document.getElementById('loginBox').style.display = 'none';
      document.getElementById('scheduleSettingsPage').style.display = 'block';
      populateScheduleSettings(settings);
    })
    .catch(() => {
      localStorage.removeItem('eventCheckinAdminAuthHeader');
      authHeader = null;
    });
}

function populateScheduleSettings(settings) {
  const regular = settings.regular || settings;
  const wednesday = settings.wednesday || {};
  document.getElementById('regularLateDropOffAfter').value = regular.lateDropOffAfter || '08:15';
  document.getElementById('regularPickUpBegins').value = regular.pickUpBegins || '14:30';
  document.getElementById('regularLatePickUpAfter').value = regular.latePickUpAfter || '14:45';
  document.getElementById('wednesdayLateDropOffAfter').value = wednesday.lateDropOffAfter || regular.lateDropOffAfter || '08:15';
  document.getElementById('wednesdayPickUpBegins').value = wednesday.pickUpBegins || '13:30';
  document.getElementById('wednesdayLatePickUpAfter').value = wednesday.latePickUpAfter || '13:45';
}

function getScheduleSettings() {
  return {
    regular: {
      lateDropOffAfter: document.getElementById('regularLateDropOffAfter').value,
      pickUpBegins: document.getElementById('regularPickUpBegins').value,
      latePickUpAfter: document.getElementById('regularLatePickUpAfter').value,
    },
    wednesday: {
      lateDropOffAfter: document.getElementById('wednesdayLateDropOffAfter').value,
      pickUpBegins: document.getElementById('wednesdayPickUpBegins').value,
      latePickUpAfter: document.getElementById('wednesdayLatePickUpAfter').value,
    },
  };
}

function saveScheduleSettings() {
  const message = document.getElementById('scheduleSettingsMessage');
  message.textContent = 'Saving...';
  fetch('/api/admin/schedule-settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authHeader },
    body: JSON.stringify(getScheduleSettings()),
  })
    .then(async (response) => {
      if (!response.ok) throw new Error((await response.json()).error || 'Unable to save schedule settings.');
      return response.json();
    })
    .then((settings) => {
      populateScheduleSettings(settings);
      message.textContent = 'Schedule settings saved.';
      message.style.color = 'green';
    })
    .catch((error) => {
      message.textContent = error.message;
      message.style.color = 'red';
    });
}

function login() {
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) })
    .then(async (response) => {
      if (!response.ok) throw new Error((await response.json()).error || 'Invalid username or password.');
      authHeader = `Basic ${btoa(`${username}:${password}`)}`;
      localStorage.setItem('eventCheckinAdminAuthHeader', authHeader);
      initScheduleSettingsPage();
    })
    .catch((error) => { document.getElementById('error').textContent = error.message; });
}

function logout() {
  localStorage.removeItem('eventCheckinAdminAuthHeader');
  window.location.href = '/admin';
}