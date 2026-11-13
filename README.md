# Phloem-AI

Phloem-AI is a local stdio MCP server that plugs into your Coding Agent, and allows it to test a web application *end to end*. The agent plans test flows and interprets results; Phloem-AI records browser facts and evaluates explicit assertions.

## Install

Configure your MCP host to launch Phloem-AI package from npm with `npx -y phloem-ai`.

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
- `browser_act`: perform one allowlisted browser operation, including navigating back
  through browser history. `uploadFiles` sends one or more existing workspace files to
  a file input selected by its accessible label; paths must resolve inside the server
  working directory, and uploads are limited to 10 files and 50 MiB total.
- `bug_report`: queue a bug title and reproduction steps from the session. On
  `session_end`, each report is replayed from a fresh browser context and recorded as
  its own WebM video under the Phloem evidence directory.
- `download_list` and `download_read`: enumerate accepted downloads and read their
  contents in chunks of up to 64 KiB. Text is returned as UTF-8; binary data is
  base64-encoded. Cross-origin links are accepted only when their response is a
  download; ordinary external page navigation remains subject to the origin
  allowlist. Download files are deleted when their browser session ends.
- `assert`: evaluate page-state or recorded-fact assertions.
- `session_end`: automatically save the explored operation history as a reusable
  TestPlan, replay queued bug reports for video evidence, close the session, and return
  the final fact roll-up. Use `plan_save` when you want a specifically named plan.
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
