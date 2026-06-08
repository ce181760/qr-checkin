function checkIn() {
  const studentName = document.getElementById("studentName").value.trim();
  const parentName = document.getElementById("parentName").value.trim();
  const roomNumber = document.getElementById("roomNumber").value.trim();

  if (studentName === "" || parentName === "" || roomNumber === "") {
    alert("Enter student name, parent name, and room number");
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
      roomNumber
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
    url.searchParams.set('roomNumber', roomNumber);
    window.location.href = url.toString();
  })
  .catch((error) => {
    console.error(error);
    alert(error.message);
  });
}
