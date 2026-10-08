# Phloem

Phloem is a local-first CLI for Gemma-guided **website** exploration and smoke testing. Give it a website URL and a short product brief; it derives user flows, explores them in a real browser, and reports which objectives passed or failed.

**DISCLAIMER:** This project is under development, so expect some things to break. Report any bugs on "issues" tab.

## What It Does

- Turns a product brief and an initial page snapshot into a bounded list of user-flow objectives.
- Explores each objective sequentially, using the current page state to choose the next supported browser operation.
- Runs browser actions locally with Playwright and headless Chromium by default. Pass `--headless=false` as flag to show Chromium.
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

Follow the prompts in your terminal until you recieve final *Phloem smoke test results* summary and it quits out of terminal.

**NOTE:** If at anytime a certain gemma-request or a certain gemma-response gets **stuck in pending** for more than 3 minutes, or if phloem **isn't showing additional requests** during process for more than 1 minute, then manually abort the process using *ctrl+C*.

## Local-First and Data

Browser automation runs on the user's machine. The brief and sanitized page snapshots are sent to the configured Google Gemma endpoint; demo credentials intentionally included in the brief are sent too. Do not include production credentials, API keys, or confidential information. Phloem does not inspect or upload application source code.

## LICENSE

Read the license for this project [here](LICENSE)