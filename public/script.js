let lateReasonRequired = false;
let latePaymentRequired = false;

window.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('input[name="action"]').forEach((input) => {
    input.addEventListener('change', resetLateReasonPrompt);
  });

  const paymentMethodSelect = document.getElementById('latePaymentMethod');
  if (paymentMethodSelect) {
    paymentMethodSelect.addEventListener('change', toggleLatePaymentSections);
  }
});

async function checkIn() {
  const studentName = document.getElementById("studentName").value.trim();
  const parentName = document.getElementById("parentName").value.trim();
  const action = document.querySelector('input[name="action"]:checked').value;
  const lateReason = document.getElementById("lateReason").value.trim();
  const latePaymentMethod = document.getElementById("latePaymentMethod").value;
  const adminSignature = document.getElementById("adminSignature").value.trim();

  if (studentName === "" || parentName === "") {
    alert("Enter student name and parent name");
    return;
  }

  if (lateReasonRequired && lateReason === "") {
    alert("Enter a reason for being late");
    return;
  }

  if (latePaymentRequired && !adminSignature) {
    alert("Enter the admin signature for the late pick-up payment");
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
      adminSignature
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
    if (checkin.actionTime) {
      url.searchParams.set('actionTime', checkin.actionTime);
    }
    if (checkin.timingStatus) {
      url.searchParams.set('timingStatus', checkin.timingStatus);
    }
    window.location.href = url.toString();
  })
  .catch((error) => {
    console.error(error);
    alert(error.message);
  });
}

function showLateReasonPrompt(error) {
  const actionLabel = error.action === 'pick_up' ? 'pick-up' : 'drop-off';
  const group = document.getElementById("lateReasonGroup");
  const lateReason = document.getElementById("lateReason");
  const paymentGroup = document.getElementById("latePaymentGroup");
  const latePaymentMethod = document.getElementById("latePaymentMethod");
  const adminSignature = document.getElementById("adminSignature");
  const message = document.getElementById("message");

  lateReasonRequired = true;
  latePaymentRequired = error.requiresLatePayment === true && error.action === 'pick_up';
  group.hidden = false;
  lateReason.required = true;
  paymentGroup.hidden = !latePaymentRequired;
  adminSignature.required = latePaymentRequired;
  toggleLatePaymentSections();
  lateReason.focus();
  message.innerText = latePaymentRequired
    ? `This ${actionLabel} is marked late. Please enter a reason and complete the late pick-up fee payment.`
    : `This ${actionLabel} is marked late. Please enter a reason.`;
}

function resetLateReasonPrompt() {
  const group = document.getElementById("lateReasonGroup");
  const lateReason = document.getElementById("lateReason");
  const paymentGroup = document.getElementById("latePaymentGroup");
  const latePaymentMethod = document.getElementById("latePaymentMethod");
  const adminSignature = document.getElementById("adminSignature");
  const message = document.getElementById("message");

  lateReasonRequired = false;
  latePaymentRequired = false;
  group.hidden = true;
  lateReason.required = false;
  lateReason.value = "";
  paymentGroup.hidden = true;
  latePaymentMethod.value = "venmo";
  adminSignature.required = false;
  adminSignature.value = "";
  toggleLatePaymentSections();
  message.innerText = "";
}

function toggleLatePaymentSections() {
  const paymentMethod = document.getElementById("latePaymentMethod").value;
  const venmoSection = document.getElementById("venmoPaymentSection");
  const cashSection = document.getElementById("cashPaymentSection");
  const adminSignature = document.getElementById("adminSignature");

  const isCash = paymentMethod === 'cash';
  venmoSection.hidden = isCash;
  cashSection.hidden = !isCash;
  adminSignature.required = latePaymentRequired;
}
