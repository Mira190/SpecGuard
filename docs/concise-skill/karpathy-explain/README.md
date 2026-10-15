# Karpathy Explain — Claude Code skill

An original, installable skill for Claude Code / Claude models inspired by Andrej Karpathy's October 2026 writing -> diagrams -> HTML -> video guidance. It converts complex model output and technical evidence into clear, inspectable explanations.

## Install in your current repository

Extract this ZIP, then place the entire `karpathy-explain` directory at:

```text
<your-repository>/.claude/skills/karpathy-explain/SKILL.md
```

All `references/`, `examples/`, and `evals/` files must stay inside the same `karpathy-explain` directory.

Windows PowerShell, from the repository root, after extracting this folder locally (replace the source path):

```powershell
New-Item -ItemType Directory -Force .claude\skills | Out-Null
Copy-Item -Recurse -Force "C:\path\to\karpathy-explain" ".claude\skills\karpathy-explain"
```

For personal use across projects, copy the directory to `%USERPROFILE%\.claude\skills\karpathy-explain` instead.

Start a new Claude Code session, or ask it to refresh skills if your version supports that, then invoke:

```text
/karpathy-explain Explain the authentication path in this repository and cite source files.
```

Claude Code can also automatically select this skill when a request matches the frontmatter description. If automatic activation is undesirable, set `disable-model-invocation: true` in `SKILL.md` frontmatter.

## Design

- **Source first** — inspect the real code/document/data rather than inventing explanations.
- **Format follows task** — controlled-language-inspired prose, Mermaid/SVG, interactive HTML, or video.
- **Verifiable output** — cite evidence, report tests honestly, preserve unknowns.
- **Safe by default** — no secrets embedded in frontend artifacts or unapproved API calls.
- **Progressive disclosure** — primary SKILL.md loads only when invoked; deeper references load as needed.

## Evaluation

`evals/cases.json` contains eight representative tests. Run fresh-session comparisons with and without the skill and score both triggering behavior and correctness using `references/quality-and-evaluation.md`.

## Research

See `references/sources.md` for official documentation and corroborating research. This is not official ASD-STE100 and does not certify formal compliance.
