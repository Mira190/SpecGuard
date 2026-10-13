# Sourced by the engine adapters. redact: stdin -> stdout with anything token-shaped replaced by ***.
# Every line copied from an engine's stderr into a note, an error file or the log goes through it first.
redact() { sed -E 's/github_pat_[A-Za-z0-9_]+/***/g; s/gh[pousr]_[A-Za-z0-9]+/***/g; s/sk-ant-[A-Za-z0-9_-]+/***/g; s/Bearer [^[:space:]]+/***/g'; }
redact_file() { [ -f "$1" ] && { redact < "$1" > "$1.r" && mv "$1.r" "$1"; }; return 0; } # in place
