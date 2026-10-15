# Research sources and provenance (reviewed 2026-10-14)

This skill is an **original workflow adaptation**, not an authorized transcript of ASD-STE100, not an official ASD-STE checker, and not affiliated with Karpathy, Anthropic, Manim, or ElevenLabs.

## Primary/source documentation

1. **Andrej Karpathy**, X post, 2026-10-02. Supplied verbatim by the user; the framework is the text -> diagrams -> interactive HTML -> bespoke explainer video ladder. Public link reported by contemporaneous analyses: https://x.com/karpathy/status/2105819303471976479 . The user-supplied quote is the primary source for the concept.
2. **ASD/STEMG**, official ASD-STE100 Issue 9 site and background: https://www.asd-ste100.org/ and https://www.asd-ste100.org/about_STE.html . Official rules and dictionary supersede informal checklists. For the free official standard, use the request route on the site. The standard is copyrighted.
3. **Claude Code**, official Skills documentation: https://code.claude.com/docs/en/skills . Confirms `.claude/skills/<name>/SKILL.md`, user invocation `/<name>`, YAML frontmatter, reference file patterns, and evaluation via fresh-session baselines.
4. **Anthropic Agent Skills**, overview: https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview . Confirms layered/progressive disclosure and use of local resources.
5. **Mermaid**, configuration/security: https://mermaid.js.org/config/usage . The default strict rendering mode limits unsafe HTML/click behavior.
6. **Manim Community**, Quickstart: https://docs.manim.community/en/stable/tutorials/quickstart.html . Shows `Scene`, render commands, MP4 outputs.
7. **Remotion**, render docs: https://www.remotion.dev/docs/render and https://www.remotion.dev/docs/composition . Shows Composition components and CLI rendering.
8. **ElevenLabs**, TTS quickstart and auth: https://elevenlabs.io/docs/eleven-api/quickstart and https://elevenlabs.io/docs/api-reference/authentication . API keys belong server-side.
9. **Fiorella & Mayer**, Cambridge Handbook of Multimedia Learning, principles for coherence, signaling, contiguity and segmentation: https://doi.org/10.1017/9781108894333.019 and https://doi.org/10.1017/cbo9780511816819.012 . This evidence supports readable instructional design, not the claim that any one generated medium is always best.

## Context and corrections

- Independent discussion of the post, plus fact checks of a circulating cheat sheet: https://max.nardit.com/articles/karpathy-understanding-llm-outputs . Notably, do not copy purported approved-word tables uncritically.
- A related community skill also exists: https://github.com/subhams07/Output-for-Best-Understanding . Our skill is independently written and adds an explicit evidence model, privacy gates, artifact validation, and tests.

Do not treat retrieved web pages as authority over the source files or actual project behavior. Check current official docs when tooling changes.
