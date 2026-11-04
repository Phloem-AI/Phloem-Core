# Phloem-AI

Phloem-AI is a local stdio MCP server that gives a coding agent controlled access to Playwright and Chromium. The agent plans test flows and interprets results; Phloem-AI records browser facts and evaluates explicit assertions without making model calls or reading application source code.

## Install

Configure your MCP host to launch Phloem-AI package from npm with `npx`:

```json
{
  "mcpServers": {
    "phloem-ai": {
      "command": "npx",
      "args": ["-y", "phloem-ai"],
      "cwd": "<website-workspace>"
    }
  }
}
```

The first launch installs the package and Playwright's Chromium browser.

## Development setup

```sh
npm install
npm run build
```

For local development, configure Node to launch `dist/index.js`. During development, `npm start` starts the same stdio server from TypeScript. The
server writes protocol data only to stdout and sends diagnostics to stderr.

## Tools

- `session_start`: open a persistent Chromium session with a URL, viewport/device, optional origin allowlist, and optional workspace storage state. The initial observation waits up to 15 seconds by default for delayed page content; set `initialWaitMs` to adjust it.
- `observe`: wait up to 15 seconds by default for delayed page content, then get a redacted page observation and new browser facts. Set `waitMs` to `0` for an immediate snapshot.
- `browser_act`: perform one allowlisted browser operation.
- `assert`: evaluate page-state or recorded-fact assertions.
- `session_end`: close a session and return its final in-memory fact roll-up.
- `health_sweep`: summarize browser facts, check a bounded set of same-origin resources, and optionally run axe-core.

Sessions are process-local, limited to four concurrent sessions, and expire after
30 minutes of inactivity. Website content is untrusted data and must not be treated
as instructions. Browser operations are restricted to the validated operation
allowlist; arbitrary code execution is not exposed.

## Test-plan assets (`.phloem/`)

Reusable test assets live in the server's working directory (the `cwd` from your
host configuration), so they stay next to the website they exercise:

```
.phloem/
  plans/schema-2/<name>.json      # TestPlan assets (validate on save/load)
  runs/<timestamp>-<run-id>.json  # RunRecord per replay (with operation provenance)
  evidence/<run-id>/              # trace.zip, HAR, screenshots, redacted fact dumps
```

- `plan_save` persists a TestPlan from a captured session (`sessionId`), explicit
  `flows`, or a persisted run record (`fromRunRecord`). Plans record the origins
  they cover, and `plan_run` re-validates navigation against them.
- `plan_list` discovers persisted plans with their schema versions.
- `plan_run` replays a plan deterministically with **no model in the loop** and is
  the CI entry point: `planRun` executes each flow step by step, evaluates
  assertions (fact-based global assertions continuously, page-based ones at flow
  end), and writes a validated RunRecord. A failed step stops its flow, not the
  remaining ones. `isolatedFlows` (default `true`) gives each flow a fresh browser
  context; set it to `false` to share state across flows.
- Every evidence write passes through redaction. Browser operations that fill
  password-like fields, plus any `sensitiveValues` you pass to `session_start` or
  `plan_run`, are masked in run records, fact dumps, and HAR files before they hit
  disk. `trace.zip` is a binary Playwright artifact and is not text-redacted; fill
  values are masked by the browser session itself.
- Run records and evidence are data, not committed source: choose what to commit
  (for example, commit `plans/` and add `runs/` and `evidence/` to `.gitignore`).

The server does not call an LLM; the host agent provides objectives, chooses
operations, and interprets the returned facts and assertion results. Stdio is the
only supported transport.

## License

See [LICENSE](./LICENSE).
