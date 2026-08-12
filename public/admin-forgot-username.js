async function sendUsernameReminder() {
  const identifier = document.getElementById('identifier').value.trim();
  const msg = document.getElementById('message');
  msg.style.color = 'green';
  msg.innerText = 'Sending...';

  try {
    const res = await fetch('/api/admin/forgot-username', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier }),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Unable to send username reminder');
    }

    if (data.emailSent) {
      msg.style.color = 'green';
      msg.innerText = 'If the identifier matches the admin account, your username reminder was sent by email.';
    } else {
      msg.style.color = 'green';
      msg.innerText = `Your username is: ${data.username}`;
    }
  } catch (err) {
    msg.style.color = 'red';
    msg.innerText = err.message || 'Error sending username reminder';
  }
}
