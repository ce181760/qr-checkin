let lateReasonRequired = false;

window.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('input[name="action"]').forEach((input) => {
    input.addEventListener('change', resetLateReasonPrompt);
  });
});

function checkIn() {
  const studentName = document.getElementById("studentName").value.trim();
  const parentName = document.getElementById("parentName").value.trim();
  const action = document.querySelector('input[name="action"]:checked').value;
  const lateReason = document.getElementById("lateReason").value.trim();

  if (studentName === "" || parentName === "") {
    alert("Enter student name and parent name");
    return;
  }

  if (lateReasonRequired && lateReason === "") {
    alert("Enter a reason for being late");
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
      lateReason
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
  const message = document.getElementById("message");

  lateReasonRequired = true;
  group.hidden = false;
  lateReason.required = true;
  lateReason.focus();
  message.innerText = `This ${actionLabel} is marked late. Please enter a reason.`;
}

function resetLateReasonPrompt() {
  const group = document.getElementById("lateReasonGroup");
  const lateReason = document.getElementById("lateReason");
  const message = document.getElementById("message");

  lateReasonRequired = false;
  group.hidden = true;
  lateReason.required = false;
  lateReason.value = "";
  message.innerText = "";
}
