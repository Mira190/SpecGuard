const users = new Map([[1, { id: 1, name: 'Ada' }]]);

function findUser(id) {
  const user = users.get(id);
  if (!user) {
    return null;
  }
  return user;
}

module.exports = { findUser };
