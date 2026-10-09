const LOCKOUT_THRESHOLD = 5;
const MIN_PASSWORD_LENGTH = 12;

function normaliseUser(name) {
  return String(name).trim().toLowerCase();
}

function passwordLongEnough(password) {
  return typeof password === 'string' && password.length >= MIN_PASSWORD_LENGTH;
}

function newState() {
  return { failures: 0, locked: false };
}

function describeState(state) {
  return state.locked ? 'locked' : 'open (' + state.failures + ' failures)';
}

function recordFailure(state) {
  const failures = state.failures + 1;
  return { failures, locked: failures >= LOCKOUT_THRESHOLD };
}

function recordSuccess(state) {
  return { failures: 0, locked: state.locked };
}

module.exports = {
  normaliseUser,
  passwordLongEnough,
  newState,
  describeState,
  recordFailure,
  recordSuccess,
};
