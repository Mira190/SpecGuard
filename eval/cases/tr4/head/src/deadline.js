const MS_PER_DAY = 86400000;
const FILING_WINDOW_DAYS = 45;

function isLate(incidentAt, filedAt) {
  const ageDays = Math.floor((filedAt - incidentAt) / MS_PER_DAY);
  return ageDays > FILING_WINDOW_DAYS;
}

module.exports = { isLate, FILING_WINDOW_DAYS };
