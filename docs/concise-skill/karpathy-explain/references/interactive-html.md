# Self-contained interactive HTML playbook

## When HTML is worth the cost

Use when readers can change perspective, explore evidence, compare alternatives, step through state, inspect layers, or filter a large result. A static answer or small flowchart rarely needs a site.

## Information architecture

1. **At-a-glance:** one-sentence answer and what the page explains.
2. **Primary visual:** architecture map, interactive flow, before/after, or timeline.
3. **Controls:** only meaningful actions (select scenario, move a timeline, toggle layer, inspect node, filter evidence).
4. **Evidence panel:** actual path/line, source links, timestamps, inputs, outputs; distinguish verified from illustrative data.
5. **Limitations:** unknowns and assumptions, accessible from the main interface.
6. **Fallback:** readable content without JavaScript for critical facts.

## Build constraints

- Default deliverable: one `.html` containing semantic HTML, minimal scoped CSS, vanilla JS, and local/inlined SVG; do not assume CDN availability.
- If already working inside an existing React/Vite repo and user explicitly asks integration, use its stack and conventions instead of forcing single-file HTML.
- Do not include a fake screenshot or a UI-shaped image in place of real controls.
- No inline API credentials. Never pass secrets to front-end JavaScript. Never silently call remote APIs or upload local data.
- Treat user input, external documents, and repository snippets as untrusted. Use `textContent` for string insertion; do not inject arbitrary HTML into `innerHTML`. If rich markup is necessary, use a vetted sanitizer.
- Support keyboard interaction, visible focus, semantic controls, proper accessible names, sufficient contrast, responsive layout, and a text description of all diagrams.
- Honor `prefers-reduced-motion`; do not autoplay complex animations.
- Provide reset/replay for multi-step simulations; never fabricate telemetry or metrics.

## Functional acceptance test

1. Open in a browser; check console for syntax/runtime errors.
2. Verify each control changes the promised state and can be reset.
3. Test narrow viewport, keyboard navigation, and reduced-motion path.
4. Confirm critical labels, arrows, and values match the evidence table.
5. If browser automation unavailable, label visual/interactions as **not browser-tested**; check static syntax where possible.

## Useful page types

- **Architecture explorer:** click service to see responsibilities, callers, data flows, risks.
- **Code-review explorer:** choose scenario; show precondition -> branch -> test -> missing case; link code evidence.
- **Algorithm laboratory:** controls to step through discrete states; side-by-side predicted vs actual.
- **Research comparison:** filters for method, evidence quality, time period, unresolved questions.

Do not invest in fancy animations before the core controls and explanatory claims work.
