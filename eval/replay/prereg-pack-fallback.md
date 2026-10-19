# Pre-registration: O as a fallback only when the pack loses changed content (arm H), fixed 2026-10-19 before H's code is run on any corpus

**Background.** This continues `prereg-pack-changed-first.md`, where arm O was not adopted: gate 6 failed on 1 of 116 confirmation PRs, and that decision is final. H is a new hypothesis, not a rescue of O. Its principle is to intervene only where there is no room, which is the point of red-team amendment 1, point 2. specguard-cf accepted it as a new hypothesis under the conditions written below.

**Arm H** (`EXP_PACK=H`):
- Build the pack as main does (arm A).
- If that pack loses changed content, return arm O's pack instead (O exactly as at e94f451).
- "Loses changed content" is the amendment-2 measure:
  - a changed RIGHT line falls past what the pack shows, or
  - a changed file with deleted LEFT lines is in the pack with 0 lines.
- The check runs inside `contextPack` on its own result.

H's code is committed before it runs on any corpus, and is not changed after.

**What is already known (design evidence, not confirmation).** On every corpus measured so far, H equals O on the PRs where A loses changed content and equals A everywhere else. Those corpora are holdout 2, fresh step 1, SpecGuard #345–#386 and the amendment-2 confirmation corpus. H's results there can be derived from the existing A and O outputs. They are reported as design evidence only.

**By construction, not evidence.** On a PR where A loses no changed content, H's pack is byte-identical to A's. So gate 6 (no rule lost where there was room) holds by construction. It is reported as "by construction" and counts for nothing. A test pins the identity.

**Confirmation corpus.** It comes from the frozen list `pack-analysis/fresh-corpus.txt` (09:37:15Z), which had never been drawn beyond step 3's first 10 lines per repo. The corpus is step 3, lines 11–40 per repo in file order: 30 per repo, 240 commits. The exact list is written and committed before any preparation. Commits the collector skips are reported as skipped, not replaced. This is the only run; nothing beyond line 40 is drawn, whatever the result.

**Adopt H as the default iff all of these hold on the confirmation corpus:**
1. **Floor.** A loses changed content on at least 10 PRs. Otherwise nothing is adopted.
2. **Fix rate.** On at least half of those PRs, H loses no changed content.
3. **No new loss.**
   - 0 PRs lose changed content under H that did not under A (true by construction; reported as such).
   - Stricter, and real: on every A-loss PR, every changed line and every deleted-line file that A showed is still shown by H, line-level. A violation fails this gate.
4. **Citations (gate 4).** On holdout 2, 0 kept standards findings cite a rule file that H drops.
5. **Tests pass.** The full suite passes, with these tests added:
   - H's pack is byte-identical to A's when A loses nothing;
   - H returns O's pack when A loses a changed line;
   - H returns O's pack when a deleted-line file is shown with 0 lines.
6. **The owner accepts the rule cost in writing.** Seeing the changed code costs rule files on the PRs where both cannot fit. O dropped 359 in-scope rule files across 41 PRs on the amendment-2 corpus. That trade-off is a product decision for the owner. H may be run first, but it is not adopted without that acceptance.

**Report** k/n for every gate. Also report:
- the per-repo split;
- the in-scope rule drops (total, and PRs affected);
- the design-corpus numbers, labelled as known.

**If adopted.** The adopting PR keeps only A plus the O fallback. It deletes F, FC, FCH and `EXP_PACK`, and keeps the A/H identity test.

**Limitation.** This measures what the model can see, not what it finds. The confirmation repos (gitea, hono, langchain, pydantic, query, rqlite, sqlglot, trpc) had few A-loss PRs in their first 10 lines (9 of 80), so the floor may not be met.
