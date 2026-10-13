// The job summary markdown is also kept in CTX/summary.md (manual runs upload it as the results artifact). Wraps the github-script `core`: addRaw appends to the file, then calls the real one.
const fs = require('node:fs');
const path = require('node:path');
module.exports = (core, file) => Object.create(core, { summary: { value: { addRaw: (text) => { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, String(text)); } catch { /* the summary itself still goes out */ } return core.summary.addRaw(text); } } } });
