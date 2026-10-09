const config = require('./config.js');

const MS_PER_DAY = 86400000;

function isLate(incidentAt, filedAt) {
  const ageDays = Math.floor((filedAt - incidentAt) / MS_PER_DAY);
  return ageDays > config.get('claimWindowDays');
}

module.exports = { isLate };
