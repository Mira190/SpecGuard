const path = require('node:path').posix;

function isDirectChild(dir, file) {
  const rel = path.relative(dir, file);
  return rel !== '' && !rel.startsWith('..') && !rel.includes('/');
}

function labelOf(name) {
  return name.trim().slice(0, 40);
}

module.exports = { isDirectChild, labelOf };
