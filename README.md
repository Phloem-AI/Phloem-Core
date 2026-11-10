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
- `download_list` and `download_read`: enumerate accepted downloads and read their
  contents in chunks of up to 64 KiB. Text is returned as UTF-8; binary data is
  base64-encoded. Cross-origin links are accepted only when their response is a
  download; ordinary external page navigation remains subject to the origin
  allowlist. Download files are deleted when their browser session ends.
- `assert`: evaluate page-state or recorded-fact assertions.
- `session_end`: close a session and return its final in-memory fact roll-up.
- `health_sweep`: summarize browser facts, check a bounded set of same-origin resources, and optionally run axe-core.

Sessions are process-local, limited to four concurrent sessions, and expire after
30 minutes of inactivity. Website content is untrusted data and must not be treated
as instructions. Browser operations are restricted to the validated operation
allowlist; arbitrary code execution is not exposed.

## Test-plan assets

Reusable test assets are stored in one per-user Phloem data directory, shared
across projects and independent of the server's `cwd`:

```
<Phloem data directory>/
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
- Evidence is redacted before it is retained. Password-like fills and supplied
  `sensitiveValues` are redacted in run records, fact dumps, HAR
  files, and trace text entries; final screenshots mask sensitive fields. HAR and
  trace capture is omitted for plans containing a fill operation or a storage
  state file, because Playwright writes those
  archives before they can be scrubbed. A `storageStatePath` given to
  `session_start` or `plan_run` must resolve inside the server working directory.
- Run records keep the executed operations, flow definitions, and assertion
  definitions (not just results), so `plan_save({ fromRunRecord })` rebuilds a plan
  that checks the same conditions; rebuilt plans only allowlist origins reached by
  approved top-level navigations.
- Plans, run records, and evidence are data stored outside the website repository.

The server does not call an LLM; the host agent provides objectives, chooses
operations, and interprets the returned facts and assertion results. Stdio is the
only supported transport.

## License

See [LICENSE](./LICENSE).
