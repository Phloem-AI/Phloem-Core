# Phloem

If you build websites, Phloem can help you test them during development. It is a local-first CLI for Gemma-guided web UI exploration and smoke testing. Give it a website URL and a short product description; it derives user flows, explores them in a real browser, and reports which objectives passed or failed.

Phloem is still in beta, so expect things to break. Open a "issue" in the Issues tab to request for new features or to report a bug.

## v0.1 Capabilities

The initial browser operation set includes same-origin navigation, accessible clicks, scrolling, filling and typing, selecting options, checking and unchecking controls, supported keyboard keys, and bounded waits for visible elements. Model responses are validated against strict schemas and Phloem maps only known operations to Playwright API calls and never evaluates model-generated code.

Each objective gets a fresh, isolated headless Chromium session. Navigation is restricted to the starting origin and exact external origins named in the original brief; subdomains are not explored. Runs are bounded by objective, browser-operation, request-rate, and duration limits.

Results are printed in the terminal as `passed`, `failed`, or `not run`, with the expected outcome, concise evidence, and a run stop reason when applicable. v0.1 does not save browser profiles, persistent evidence, replayable tests, or recordings.

## Local-First and Data

Browser automation runs on the user's machine. The brief and sanitized page snapshots are sent to the configured Google Gemma endpoint; demo credentials intentionally included in the brief are sent too. Do not include production credentials, API keys, or confidential information. Phloem does not inspect or upload application source code.

The target page may itself load third-party resources in Chromium. Phloem limits its own navigations, but a run is not a network-isolated browser session.

## Scope

Phloem v0.1 is exploratory smoke testing, not a full E2E suite. It tests brief-derived, user-visible flows and cannot guarantee exhaustive coverage of every route, state, endpoint, or input. HTTP/API testing, native mobile/desktop testing, source-code inspection, test recording/replay, and automatic repair loops are out of scope.
