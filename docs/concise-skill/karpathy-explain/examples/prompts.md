# Example prompts for Claude Code

Use directly in Claude Code (without asking it to author another skill):

```text
/karpathy-explain Explain the request path across this repository, starting at the API route. Show the exact evidence for every edge.
```

```text
/karpathy-explain Rewrite this technical document in an approximately 80%-ASD-STE100-inspired style. Keep technical names, warnings, conditions, and citations exactly correct.
```

```text
/karpathy-explain diagram Compare the old and new retry behavior in PR #123. Show the success, 429, timeout, and cancellation branches. Mark unverified branches.
```

```text
/karpathy-explain html Build a standalone interactive explanation of our test-data retrieval, cache, and stock-level workflows. Each node should link to repository evidence. Do not make network requests from the page.
```

```text
/karpathy-explain video Create a 45-second animated explanation of topological sorting. Prefer Manim, add captions, and use local/offline narration if available. Verify the MP4 exists before claiming success.
```

```text
/karpathy-explain Inspect the GitHub Actions Code Review workflow. Explain what triggers it, what input URLs it accepts, how it loads repo-specific instructions, what secrets it can access, and which claims are still assumptions. Choose text or diagrams before building HTML.
```

```text
/karpathy-explain Help me understand an agent's result. Separate observed facts, hypothesis, and counterevidence. Pick the smallest format that helps me audit it.
```

## Expected behavior

If a request is simple, reply with a clear answer. For repo-wide code explanations, read relevant files, link evidence, and use a diagram when helpful. Do not produce an entire website merely because the skill supports HTML. Explicit formats override the default choice. Do not assert that rendering, tests, or browser interactions ran without actually running them.
