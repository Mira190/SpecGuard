---
applyTo: "**"
excludeAgent: "cloud-agent"
---
On every pull request review, use the `test-review` skill in `.github/skills/test-review/` (Copilot code review mode).
Check that the requirements and the changed behaviour are proven by unit tests, that the repo's coding standard is followed,
and whether logic is tested only at component or integration level when it belongs in unit tests.
Report findings as the skill describes.
