const settings = () => JSON.parse(process.env.CLAIM_SETTINGS || '{}');

module.exports = { get: (key) => settings()[key] };
