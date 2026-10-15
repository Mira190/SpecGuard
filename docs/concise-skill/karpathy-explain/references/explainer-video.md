# Animated explainer video playbook

## Purpose

Use motion to clarify **change over time**, not as an expensive replacement for searchable information. A clear short animation is preferable to a long cinematic slideshow. Karpathy suggested 3Blue1Brown-style educational video with optional ElevenLabs narration. This means mathematical visual pedagogy and carefully staged transformations, NOT imitation of an identifiable narrator's voice, trademarks, original assets, or copyrighted scenes.

## Preflight

Check whether rendering tools are installed and allowed (e.g. `manim`, Node.js/Remotion, `ffmpeg`/`ffprobe`, and optional TTS). Do not assume paid API access or network access. Before installing dependencies or using paid hosted services, obey user/project approval rules.

## Workflow

1. State the learning objective and 2–5 key propositions; ground them in evidence.
2. Make a **scene storyboard** with duration, visible elements, change/transition, caption, narration and source/evidence for each scene.
3. Choose the renderer:
   - **Manim Community:** equations, geometry, graphs, algorithm evolution, transformations. Use a Python `Scene` with `construct()` and test a low-quality render first (`manim -ql scene.py SceneName`; add `-p` to preview when desktop available).
   - **Remotion:** React-based compositing, UI demo, charts, multi-scene timelines. Declare a `Composition` with FPS and frames; render with `npx remotion render <composition-id> [output-path]` from a valid Remotion project.
   - If neither is viable, deliver a documented storyboard, transcript, and **runnable source only if you created it**. Do not call it a rendered video.
4. Design each scene around a single concept; keep important labels close to the changing object.
5. Generate narration only when optional TTS is available and permitted. ElevenLabs uses `ELEVENLABS_API_KEY` as an environment secret (not embedded in source). Offer local TTS, subtitles or a silent video alternative. Do not claim a particular voice or endpoint exists without checking available voices/API docs.
6. Synchronize voice and scene transitions. Provide subtitles/captions and a transcript.
7. Render an actual MP4, inspect a sampling of frames, and verify duration, soundtrack/captions, legibility, no clipping and timing. Use `ffprobe` if installed.
8. Supply the video file **and** editable project/source; note the renderer and verified output path.

## Scene format

| Scene | Time | Main proposition | Visual change | Caption/narration | Evidence |
|---|---:|---|---|---|---|
| 1 | 0–8s | Setup | Introduce entities | Define 1–2 names | source A |
| 2 | 8–20s | Mechanism | Animate each transition | Narrate actions, not decorations | source B |
| 3 | 20–30s | Boundary | Contrast success/failure | State condition explicitly | source C |
| 4 | 30–40s | Recap | Show simplified causal chain | End with one testable takeaway | source A–C |

Times are illustrative, not requirements.

## No false-completion policy

- A narration script is not an audio file.
- A storyboard is not a rendered MP4.
- Rendering commands are not evidence they were executed.
- A silent MP4 is not a narrated video.
- If rendering is blocked, provide the best verified deliverables, name the limitation, and include direct reproduction steps.
