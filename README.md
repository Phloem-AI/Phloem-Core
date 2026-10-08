# Phloem

Phloem is a local-first CLI for Gemma-guided web UI exploration and smoke testing. Give it a website URL and a short product brief; it derives user flows, explores them in a real browser, and reports which objectives passed or failed.

## What It Does

- Turns a product brief and an initial page snapshot into a bounded list of user-flow objectives.
- Explores each objective sequentially, using the current page state to choose the next supported browser operation.
- Runs browser actions locally with Playwright and headless Chromium by default. Pass `--headless=false` to show Chromium.
- Uses accessible roles and names to locate controls, and observes page snapshots, URL/title, visible text, console errors, and failed requests.
- Asks Gemma to assess each completed flow against its expected outcome and prints a result for every objective.

## Quick setup

*Fork* the repo, *clone* it down locally on your machine. Then run:

```
cd phloem-core
npm install
npm start
```

If you want to know the **flags** that phloem supports, do: ```npm start -- --help``` , it lists down the flags you can pass as ```npm start -- --flag_name```.

## v0.1 Capabilities

The initial browser operation set includes same-origin navigation, accessible clicks, scrolling, filling and typing, selecting options, checking and unchecking controls, supported keyboard keys, and bounded waits for visible elements. Model responses are validated against strict schemas; Phloem maps only known operations to Playwright API calls and never evaluates model-generated code.

Each objective gets a fresh, isolated Chromium session. It runs headless by default; pass `--headless=false` to show the browser. Navigation is restricted to the starting origin and exact external origins named in the original brief; subdomains are not explored. Runs are bounded by objective, browser-operation, request-rate, and duration limits.

Results are printed in the terminal as `passed`, `failed`, or `not run`, with the expected outcome, concise evidence, and a run stop reason when applicable. v0.1 does not save browser profiles, persistent evidence, replayable tests, or recordings.

## Local-First and Data

Browser automation runs on the user's machine. The brief and sanitized page snapshots are sent to the configured Google Gemma endpoint; demo credentials intentionally included in the brief are sent too. Do not include production credentials, API keys, or confidential information. Phloem does not inspect or upload application source code.

The target page may itself load third-party resources in Chromium. Phloem limits its own navigations, but a run is not a network-isolated browser session.

## Scope

Phloem v0.1 is exploratory smoke testing, not a full E2E suite. It tests brief-derived, user-visible flows and cannot guarantee exhaustive coverage of every route, state, endpoint, or input. HTTP/API testing, native mobile/desktop testing, source-code inspection, test recording/replay, and automatic repair loops are out of scope.