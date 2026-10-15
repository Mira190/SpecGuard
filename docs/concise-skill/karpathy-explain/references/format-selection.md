# Format selection: intelligibility before spectacle

## The principle

Karpathy's October 2, 2026 post lists writing, diagrams/images, HTML pages, and bespoke explainer videos, with escalating excitement about richer media. This is **not** evidence that video always yields superior comprehension. Choose based on the cognitive operation the audience must perform and the cost of producing/inspecting the artifact.

| Reader's question | Best initial representation | When to change |
|---|---|---|
| What does this mean? | Concise, concrete text | Add diagram if relationships become hard to hold in memory |
| What talks to what? | Dependency/data-flow or sequence diagram | Add interactive HTML if many layers need expansion |
| Where did the PR change behavior? | Evidence table + before/after flow | Add HTML if many branches, examples, or files |
| How does the algorithm evolve? | State diagram or time-stepped HTML | Video when motion genuinely makes the transformation easier |
| Which of 20 options fit my constraints? | Searchable comparison UI | Text suffices for 2–3 options |
| What exactly failed? | Causal chain plus file/line evidence | Avoid cinematic visuals; verification matters more |

## Cognitive-load design principles

Adapted (not quoted) from multimedia-learning research:
- **Coherence:** omit decorative elements unrelated to the mechanism.
- **Signaling:** show critical states, transitions, and contrasts with labels and highlights.
- **Spatial contiguity:** place labels beside the objects they describe.
- **Temporal contiguity:** synchronize animation with the relevant narration/caption.
- **Segmentation:** provide reader-controlled steps for complex processes; avoid high-speed autoplay.
- **Pre-training:** define entities and notations before demonstrating interactions.
- **Accessibility:** diagrams and videos need complementary verbal summaries. A media-rich output is not inherently accessible or correct.

## Explicit versus inferred requirements

- User asked for Markdown -> deliver Markdown. No surprise HTML or video.
- User asked for "visualize" but not a format -> choose diagram unless interactivity or motion is essential.
- User asked for "fully interactive" -> deliver a real HTML/interactive artifact, not a screenshot of one.
- User asked for a video -> prioritize renderable source and an actual video; a script/storyboard is a fallback, clearly labeled.
- No browser or rendering tool -> do not claim visual verification; provide source and the command to render.

## Scope and budget heuristic

Before creating HTML/video, verify that it adds one of: direct manipulation, time-based demonstration, significantly reduced cross-reference, or meaningful inspection of large state space. Keep the artifact proportional to the question. One clear diagram often beats a complex interface.
