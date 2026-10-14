function normalizeName(name) {
  if (name.trim() === '') {
    throw new Error('name required');
  }
  return name.trim();
}

module.exports = { normalizeName };
