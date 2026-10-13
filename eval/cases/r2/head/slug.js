function slugify(title) {
  if (typeof title !== 'string') {
    throw new TypeError('title must be a string');
  }
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

module.exports = { slugify };
