function checkIn() {
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
  .then((checkin) => {
    const url = new URL('/checkin-success.html', window.location.origin);
    url.searchParams.set('studentName', studentName);
    url.searchParams.set('parentName', parentName);
    if (checkin.arrivalTime) {
      url.searchParams.set('arrivalTime', checkin.arrivalTime);
    }
    window.location.href = url.toString();
  })
  .catch((error) => {
    console.error(error);
    alert(error.message);
  });
}
