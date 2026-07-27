function getQueryParam(name) {
  const params = new URLSearchParams(window.location.search);
  return params.get(name);
}

document.addEventListener('DOMContentLoaded', () => {
  const token = getQueryParam('token') || '';
  document.getElementById('token').value = token;
  if (!token) {
    document.getElementById('message').style.color = 'red';
    document.getElementById('message').innerText = 'Missing reset token.';
  }
});

async function resetPassword() {
  const token = document.getElementById('token').value.trim();
  const password = document.getElementById('password').value;
  const confirm = document.getElementById('confirm').value;
  const msg = document.getElementById('message');
  msg.style.color = 'green';
  msg.innerText = 'Submitting...';

  if (!token) {
    msg.style.color = 'red';
    msg.innerText = 'Missing token.';
    return;
  }

  if (!password || password !== confirm) {
    msg.style.color = 'red';
    msg.innerText = 'Passwords must match.';
    return;
  }

  try {
    const res = await fetch('/api/admin/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, password }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => 'Unable to reset password');
      throw new Error(text || 'Unable to reset password');
    }

    msg.style.color = 'green';
    msg.innerText = 'Password reset successful. You may now log in.';
  } catch (err) {
    msg.style.color = 'red';
    msg.innerText = err.message || 'Error resetting password';
  }
}
