# Clear technical writing inspired by ASD-STE100

## Status and scope

ASD-STE100 Issue 9 (January 15, 2025) is an official technical-English standard maintained by ASD/STEMG. The official specification has a rules part and a controlled dictionary. These notes are an **adaptation for AI explanations**, not a reproduction, validated vocabulary list, or compliance certificate. "80% of the way" is Karpathy's informal preference, not a defined standard score.

The full STE discipline distinguishes dictionary-approved words, technical nouns, and technical verbs; the same surface word may be allowed in only one meaning or part of speech. Do **not** deduce approval from familiarity, or assert that these example rewrites meet every dictionary rule.

## Practical guidelines for model output

1. **One concept, one term.** Choose a short technical noun and keep it constant. Example: do not alternate among "request," "command," and "event" for the same message.
2. **Concrete subject and verb.** "The runner loads the config" beats "the configuration is loaded" when the actor matters.
3. **Present actions in sequence.** Preconditions first; each sentence describes one action when writing instructions.
4. **Short English sentences.** Aim at <=20 words for operational instructions and <=25 words for descriptions. Break complex clauses. Technical accuracy takes precedence over the heuristic.
5. **Short paragraphs.** Keep one point per paragraph; usually no more than six sentences.
6. **Explicit logic.** Say "if," "only if," "unless," and "after" clearly. Do not bury a condition in a footnote.
7. **No decorative synonyms.** Prefer "use" or "start" where appropriate. Avoid verbose filler, business jargon, overconfident adjectives, and vague pronouns.
8. **Expand acronyms on first use** when an audience might not recognize them. Preserve API names, file names, code, and relevant abbreviations exactly.
9. **Show quantities with units** and state whether numbers are measured, estimates, or illustrative examples.
10. **Keep negatives and warnings prominent.** Never trade away exceptions, ambiguity, constraints, or probability to get a shorter sentence.
11. **Audience-aware bilingual writing.** For Chinese, apply the principles of concise structure, stable terms, and explicit dependencies; do not pretend it is certified English STE.
12. **No fake dictionary tables.** The popular image circulating with Karpathy's post mislabels `approximately` and `test`; check any strict word approval against the official Issue 9 dictionary. For ordinary software documentation, do not claim strict STE compliance.

## Example: generic agent status (illustrative, NOT formal STE)

**Before:** "In light of potential downstream considerations, it is recommended that the application of the automated reviewer be conditionally deferred pending the satisfactory completion of the comprehensive test suite."

**After:** "Run the test suite before you enable the automated reviewer. If any required test fails, do not enable it."

**Before:** "Various aspects of the test coverage appear to be suboptimal."

**After:** "The tests do not cover the retry branch. Add a test where the second request returns HTTP 429."

## Recommended format for technical explanations

**Core idea.** One or two sentences.

**Mechanism.** 3–5 short steps; preserve causal order.

**Evidence.** Repo path/line, test result, data source, or verified citation.

**Limits.** Uncertainties, alternative explanations, and failure cases.

**Verify.** One specific check the reader can perform.

## Limits of the 80% heuristic

- Do not make arbitrary forbidden-word lists.
- Do not remove essential legal, medical, safety, or engineering nuance.
- Do not simplify code snippets so much that they cease to run.
- Do not replace precise names/units with informal synonyms.
- For a strict ASD-STE100 compliance audit, obtain the official standard, appropriate project terminology and an appropriate checker; do not self-certify by prompting alone.
