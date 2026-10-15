#!/usr/bin/env python3
"""Minimal, offline structural validation for the packaged Claude Code skill."""
from __future__ import annotations
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
FILE = ROOT / "SKILL.md"
errors = []
assert FILE.exists(), f"Missing {FILE}"
body = FILE.read_text(encoding="utf-8")
parts = body.split("---", 2)
if len(parts) < 3 or parts[0].strip():
    errors.append("SKILL.md has no initial YAML frontmatter")
else:
    fm = parts[1]
    name = re.search(r"(?m)^name:\s*(\S.*)$", fm)
    descr = re.search(r"(?m)^description:\s*(.+)$", fm)
    if not name or not re.fullmatch(r"[a-z0-9-]{1,64}", name.group(1).strip()):
        errors.append("Missing or invalid name")
    if not descr or not (1 <= len(descr.group(1)) <= 1024):
        errors.append("Missing or invalid description (1-1024 chars)")
for rel in re.findall(r"\]\((references/[^)]+|examples/[^)]+)\)", body):
    if not (ROOT / rel).is_file():
        errors.append(f"Broken link: {rel}")
casefile = ROOT / "evals" / "cases.json"
try:
    cases = json.loads(casefile.read_text(encoding="utf-8"))
    if len(cases) < 6 or any(not all(k in c for k in ("id", "prompt", "expected", "checks")) for c in cases):
        errors.append("Eval cases invalid or incomplete")
except Exception as exc:
    errors.append(f"Cannot parse evals/cases.json: {exc}")
for file in ROOT.rglob("*.md"):
    if not file.read_text(encoding="utf-8").strip():
        errors.append(f"Empty markdown file: {file.relative_to(ROOT)}")
if errors:
    print("FAIL:\n" + "\n".join("- " + e for e in errors))
    sys.exit(1)
link_count = len(re.findall(r"\]\((?:references|examples)/", body))
print(f"PASS: {ROOT.name}: frontmatter, {link_count} links, {len(cases)} evaluation cases, and Markdown files")
