let lateReasonRequired = false;
let latePaymentRequired = false;

window.addEventListener('DOMContentLoaded', () => {
  const studentNameInput = document.getElementById('studentName');
  const actionInputs = document.querySelectorAll('input[name="action"]');

  actionInputs.forEach((input) => {
    input.addEventListener('change', resetLateReasonPrompt);
  });

  const paymentMethodSelect = document.getElementById('latePaymentMethod');
  if (paymentMethodSelect) {
    paymentMethodSelect.addEventListener('change', toggleLatePaymentSections);
  }

  if (studentNameInput) {
    studentNameInput.addEventListener('change', updateDefaultPickupAction);
    studentNameInput.addEventListener('blur', updateDefaultPickupAction);
  }

  updateDefaultPickupAction();
});

async function updateDefaultPickupAction() {
  const studentNameInput = document.getElementById('studentName');
  const pickupInput = document.querySelector('input[name="action"][value="pick_up"]');
  const dropOffInput = document.querySelector('input[name="action"][value="drop_off"]');

  if (!studentNameInput || !pickupInput || !dropOffInput) {
    return;
  }

  const studentName = studentNameInput.value.trim();
  if (!studentName) {
    return;
  }

  try {
    const response = await fetch('/attendance');
    if (!response.ok) {
      return;
    }

    const records = await response.json();
    const today = new Date();
    const todayKey = new Date(today.getTime() - (today.getTimezoneOffset() * 60000)).toISOString().slice(0, 10);
    const alreadyCheckedIn = records.some((record) => {
      const normalizedStudent = String(record.studentName || '').trim().toLowerCase();
      const normalizedInput = studentName.toLowerCase();
      const recordDate = String(record.eventDate || record.arrivalDate || '').slice(0, 10);
      const hasPickup = Boolean(record.pickUpTimestamp);
      return normalizedStudent === normalizedInput && recordDate === todayKey && !hasPickup;
    });

    if (alreadyCheckedIn) {
      pickupInput.checked = true;
      dropOffInput.checked = false;
      resetLateReasonPrompt();
    }
  } catch (error) {
    console.warn('Unable to detect existing student attendance.', error);
  }
}

async function checkIn() {
  const studentName = document.getElementById("studentName").value.trim();
  const parentName = document.getElementById("parentName").value.trim();

  if (studentName === "" || parentName === "") {
    alert("Enter student name and parent name");
    return;
  }

  fetch('/checkin', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      studentName,
      parentName
    })
  })
  .then(async (response) => {
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || 'Unable to save check-in');
    }
    return response.json();
  })
  .then(() => {
    const url = new URL('/checkin-success.html', window.location.origin);
    url.searchParams.set('studentName', studentName);
    url.searchParams.set('parentName', parentName);
    window.location.href = url.toString();
  })
  .catch((error) => {
    console.error(error);
    alert(error.message);
  });
}
