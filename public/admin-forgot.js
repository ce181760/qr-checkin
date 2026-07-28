async function sendReset() {
  const email = document.getElementById('email').value.trim();
  const msg = document.getElementById('message');
  msg.style.color = 'green';
  msg.innerText = 'Sending...';

  try {
    const res = await fetch('/api/admin/forgot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => 'Unable to send reset link');
      throw new Error(text || 'Unable to send reset link');
    }

    msg.style.color = 'green';
    msg.innerText = 'If the email matches the admin account, a reset link was sent.';
  } catch (err) {
    msg.style.color = 'red';
    msg.innerText = err.message || 'Error sending reset link';
  }
}
