const MAX_AGE_DAYS = 30;

function validateIncidentAge(ageDays) {
  return ageDays <= MAX_AGE_DAYS ? null : 'too old';
}

module.exports = { validateIncidentAge };
