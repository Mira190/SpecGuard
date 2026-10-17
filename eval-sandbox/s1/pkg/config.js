function getPort(env) {
  if (!env.PORT) {
    throw 'PORT is required';
  }
  return Number(env.PORT);
}

module.exports = { getPort };
