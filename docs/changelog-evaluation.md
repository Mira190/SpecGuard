# Evaluation changelog

## 2026-10-09

Hashes are from `git log`; each links to its commit.

- Research docs: competitor head-to-head, instruction-discovery and native Copilot integration research, field study. Why: record what is and is not verified. [7500a16](https://github.com/Mira190/SpecGuard/commit/7500a16)
- Free-form competitor-style runs in `eval/ab.js`, field study harness. Why: compare lean against copilot-style and pocock-style prompts blind, and measure discovery on real repos. [70210f3](https://github.com/Mira190/SpecGuard/commit/70210f3)
- Preflight skip for closed, bot-authored and already-reviewed heads; inputs `include_bots`, `force`. Why: spend no model tokens where a review adds nothing. [8beceff](https://github.com/Mira190/SpecGuard/commit/8beceff)
- Standards applicability map, sources-read manifest, head SHA marker, ignore svg/log/map. Why: reject standards findings citing rules that do not cover the file; show what was read. [f4a9388](https://github.com/Mira190/SpecGuard/commit/f4a9388), merged by [a95bb52](https://github.com/Mira190/SpecGuard/commit/a95bb52)
- Tighter requirement-doc discovery, time budget, candidate caps, merged as [d786847](https://github.com/Mira190/SpecGuard/commit/d786847). Why: the field study showed false discovery in repos without requirement docs and trace timeouts. Parts: [0e51b73](https://github.com/Mira190/SpecGuard/commit/0e51b73) time budget, in-depth S cap, candidate caps; [832d0f6](https://github.com/Mira190/SpecGuard/commit/832d0f6) in-process identifier scan; [4cf6d8a](https://github.com/Mira190/SpecGuard/commit/4cf6d8a) stricter parsing; [90f94b1](https://github.com/Mira190/SpecGuard/commit/90f94b1) prose-only admission; [8dea6df](https://github.com/Mira190/SpecGuard/commit/8dea6df) skip HTML comments; [c177f63](https://github.com/Mira190/SpecGuard/commit/c177f63) RFC-capital density; [fa5f747](https://github.com/Mira190/SpecGuard/commit/fa5f747) and [8af3a88](https://github.com/Mira190/SpecGuard/commit/8af3a88) link definitions are not ID items.
- post.js drops code blocks with unresolved placeholders and keeps the prose. Why: unresolved placeholders are not verifiable code. [9e97df5](https://github.com/Mira190/SpecGuard/commit/9e97df5)
- post.js keeps verified findings instead of dropping them over bookkeeping slips. Why: dropping a verified finding loses true signal. [fa7b2f4](https://github.com/Mira190/SpecGuard/commit/fa7b2f4)
- Differential: a nearby edit counts only when it defines a name the behaviour line uses. Why: avoid marking pre-existing mismatches as introduced. [0375548](https://github.com/Mira190/SpecGuard/commit/0375548)
- Lean prompt: `src/prompt.js` assembler, compact skill and references. Why: cumulative input was dominated by the static prompt (`docs/token-anatomy.md`). [2861804](https://github.com/Mira190/SpecGuard/commit/2861804), [a9fa143](https://github.com/Mira190/SpecGuard/commit/a9fa143), merged by [fc0e503](https://github.com/Mira190/SpecGuard/commit/fc0e503)
- Real-bug replay (SZZ), mutation proof, evidence signals, token anatomy tooling. Why: measure against shipped bugs and cost. [120af93](https://github.com/Mira190/SpecGuard/commit/120af93)
