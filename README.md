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

## Current scope

Plans, run records, screenshots, traces, and other evidence are not persisted yet.
Plan save/replay tools are deferred. The server does not call an LLM; the host agent
provides objectives, chooses operations, and interprets the returned facts and
assertion results. Stdio is the only supported transport.

## License

See [LICENSE](./LICENSE).
