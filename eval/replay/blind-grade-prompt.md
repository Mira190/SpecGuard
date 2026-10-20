You are grading whether an automated code review caught a specific bug. Follow the rubric exactly. You see one bug and one list of review findings; decide from the text only.

# Rubric

- `direct`: a finding names the defective behaviour or the violated requirement.
- `indirect`: a `missing_test` or `weak_test` finding on the exact behaviour that later broke, such that a test written to that finding would have failed.
- `miss`: neither.

Only findings on the blamed or fixed lines, or naming the same requirement, count. Record inline and summary-only findings separately. Catch rate is (direct + indirect) / in-scope confirmed bugs with a Wilson 95% interval; report nothing as a rate below 30 in-scope confirmed bugs.

# BUG

{{BUG}}

# FIX DIFF

{{DIFF_NOTE}}

{{DIFF}}

# FINDINGS

{{FINDINGS}}

# Answer

Reply with strict JSON only, no other text:
{"grade":"direct"|"indirect"|"miss","finding":<number of the deciding finding, or null>,"why":"<one sentence>"}
