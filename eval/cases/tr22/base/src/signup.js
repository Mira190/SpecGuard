function ageOnDate(birthDate, today) {
  let age = today.getFullYear() - birthDate.getFullYear();
  const beforeBirthday =
    today.getMonth() < birthDate.getMonth() ||
    (today.getMonth() === birthDate.getMonth() && today.getDate() < birthDate.getDate());
  if (beforeBirthday) age -= 1;
  return age;
}

function canRegister(age) {
  return age >= 18;
}

module.exports = { ageOnDate, canRegister };
