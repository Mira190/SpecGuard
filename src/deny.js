// Secret-like paths: never sent to a model. Dependency-free; claude-api.js, deny-filter.js and trace.js all take it from here.
module.exports = { DENY: /(^|\/)(\.git|\.specguard-(ctx|src))(\/|$)|(^|\/)(\.env(\.[^/]*)?|[^/]*\.env|[^/]*\.pem|[^/]*\.key|id_rsa[^/]*)$/i };
