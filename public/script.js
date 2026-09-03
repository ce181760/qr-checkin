let lateReasonRequired = false;
let latePaymentRequired = false;

window.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('input[name="action"]').forEach((input) => {
    input.addEventListener('change', resetLateReasonPrompt);
  });
});

async function checkIn() {
  const studentName = document.getElementById("studentName").value.trim();
  const parentName = document.getElementById("parentName").value.trim();
  const action = document.querySelector('input[name="action"]:checked').value;
  const lateReason = document.getElementById("lateReason").value.trim();
  const latePaymentMethod = document.querySelector('input[name="latePaymentMethod"]:checked').value;
  const latePaymentConfirmed = document.getElementById("latePaymentConfirmed").checked;
  const receiptInput = document.getElementById("latePaymentReceipt");
  const receiptFile = receiptInput.files[0] || null;

  if (studentName === "" || parentName === "") {
    alert("Enter student name and parent name");
    return;
  }

  if (lateReasonRequired && lateReason === "") {
    alert("Enter a reason for being late");
    return;
  }

  if (latePaymentRequired && !latePaymentConfirmed) {
    alert("Confirm the $10 late pick-up payment to @phcs1166");
    return;
  }

  if (latePaymentRequired && latePaymentMethod === 'venmo' && !receiptFile) {
    alert("Upload a receipt screenshot for the late pick-up payment");
    return;
  }

  let latePaymentReceipt = null;
  try {
    latePaymentReceipt = receiptFile ? await readReceiptFile(receiptFile) : null;
  } catch (error) {
    alert(error.message);
    return;
  }

  fetch('/checkin', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      studentName,
      parentName,
      action,
      lateReason,
      latePaymentMethod,
      latePaymentConfirmed,
      latePaymentReceipt
    })
  })
  .then(async (response) => {
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      if (error.requiresLateReason) {
        showLateReasonPrompt(error);
        return null;
      }
      throw new Error(error.error || 'Unable to save check-in');
    }
    return response.json();
  })
  .then((checkin) => {
    if (!checkin) {
      return;
    }
    if (checkin.timingStatus === 'Late' && lateReason === "") {
      showLateReasonPrompt(checkin);
      return;
    }
    const url = new URL('/checkin-success.html', window.location.origin);
    url.searchParams.set('studentName', studentName);
    url.searchParams.set('parentName', parentName);
    url.searchParams.set('action', checkin.action || action);
    if (checkin.eventDate) {
      url.searchParams.set('eventDate', checkin.eventDate);
    }
    if (checkin.actionTime) {
      url.searchParams.set('actionTime', checkin.actionTime);
    }
    if (checkin.timingStatus) {
      url.searchParams.set('timingStatus', checkin.timingStatus);
    }
    if (lateReason) {
      url.searchParams.set('lateReason', lateReason);
    }
    window.location.href = url.toString();
  })
  .catch((error) => {
    console.error(error);
    alert(error.message);
  });
}

function readReceiptFile(file) {
  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  const maxBytes = 5 * 1024 * 1024;

  if (!allowedTypes.includes(file.type)) {
    return Promise.reject(new Error("Receipt must be a JPG, PNG, GIF, or WebP image"));
  }

  if (file.size > maxBytes) {
    return Promise.reject(new Error("Receipt image must be 5 MB or smaller"));
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({
      name: file.name,
      type: file.type,
      size: file.size,
      dataUrl: reader.result,
    });
    reader.onerror = () => reject(new Error("Could not read the receipt image"));
    reader.readAsDataURL(file);
  });
}

function showLateReasonPrompt(error) {
  const actionLabel = error.action === 'pick_up' ? 'pick-up' : 'drop-off';
  const group = document.getElementById("lateReasonGroup");
  const lateReason = document.getElementById("lateReason");
  const paymentGroup = document.getElementById("latePaymentGroup");
  const latePaymentConfirmed = document.getElementById("latePaymentConfirmed");
  const latePaymentReceipt = document.getElementById("latePaymentReceipt");
  const paymentMethodInputs = document.querySelectorAll('input[name="latePaymentMethod"]');
  const venmoPaymentDetails = document.getElementById("venmoPaymentDetails");
  const message = document.getElementById("message");

  lateReasonRequired = true;
  latePaymentRequired = error.requiresLatePayment === true && error.action === 'pick_up';
  group.hidden = false;
  lateReason.required = true;
  paymentGroup.hidden = !latePaymentRequired;
  latePaymentConfirmed.required = latePaymentRequired;
  latePaymentReceipt.required = latePaymentRequired && document.querySelector('input[name="latePaymentMethod"]:checked').value === 'venmo';
  paymentMethodInputs.forEach((input) => input.addEventListener('change', () => {
    const isVenmo = input.checked && input.value === 'venmo';
    venmoPaymentDetails.hidden = !isVenmo;
    latePaymentReceipt.required = latePaymentRequired && isVenmo;
  }));
  lateReason.focus();
  message.innerText = latePaymentRequired
    ? `This ${actionLabel} is marked late. Please enter a reason, pay the $10 late pick-up fee to @phcs1166, and upload the receipt.`
    : `This ${actionLabel} is marked late. Please enter a reason.`;
}

function resetLateReasonPrompt() {
  const group = document.getElementById("lateReasonGroup");
  const lateReason = document.getElementById("lateReason");
  const paymentGroup = document.getElementById("latePaymentGroup");
  const latePaymentConfirmed = document.getElementById("latePaymentConfirmed");
  const latePaymentReceipt = document.getElementById("latePaymentReceipt");
  const venmoPaymentDetails = document.getElementById("venmoPaymentDetails");
  const message = document.getElementById("message");

  lateReasonRequired = false;
  latePaymentRequired = false;
  group.hidden = true;
  lateReason.required = false;
  lateReason.value = "";
  paymentGroup.hidden = true;
  latePaymentConfirmed.required = false;
  latePaymentConfirmed.checked = false;
  latePaymentReceipt.required = false;
  latePaymentReceipt.value = "";
  venmoPaymentDetails.hidden = false;
  message.innerText = "";
}
