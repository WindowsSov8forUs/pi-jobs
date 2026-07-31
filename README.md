# pi-jobs

A persistent, model-driven job queue for complex Pi tasks.

When a task has multiple execution stages, the model can start a jobs lifecycle, enqueue the stages in order, advance or defer the queue head, and keep large cross-stage notes in external memory. Simple tasks do not need a jobs queue.

## Install

Install a pinned GitHub Release, replacing `OWNER` with the repository owner:

```bash
pi install git:github.com/OWNER/pi-jobs@v0.1.1
```

To try it without changing Pi settings:

```bash
pi -e git:github.com/OWNER/pi-jobs@v0.1.1
```

A tag pins the installed version. After a new release, install the new tag explicitly. An unpinned default-branch install can instead be updated with `pi update --extensions`, but is less reproducible.

## Runtime layout

For session `12345678-...`, runtime data lives only under:

```text
~/.pi/agent/jobs/12345678/
├── state.json
├── timeline.jsonl
└── tmp/
```

`PI_CODING_AGENT_DIR` replaces `~/.pi/agent` when configured. The extension source remains in `~/.pi/agent/extensions/pi-jobs/`.

## Tools

Recommended flow:

1. `start_jobs({ name, intent, detail? })`
2. `create_job({ jobs: [{ label }, ...] })`
3. Work only on the returned head job.
4. Call `finish_job({ jobId })` when the head is complete or no longer needed.
5. Call `pend_job({ jobId })` when the head should move behind the other jobs.
6. Use `update_jobs_state({ state, detail })` for working/blocked status.
7. Use `finish_jobs({ detail? })` to clear the entire queue and mark it done.
8. Use `check_jobs()` whenever the current state is uncertain.

`finish_job` and `pend_job` accept only the current head ID. This guards against stale model state deleting or moving the wrong job.

When `finish_job` removes the final item, `update_jobs_state` marks an empty lifecycle done, or `finish_jobs` clears the queue, the tool response reports the frozen metrics to the model in both text and `details.finalMetrics`:

```json
{
  "activeTimeMs": 12500,
  "activeTime": "12.5s",
  "tokens": 12345,
  "tokensDisplay": "12.3k",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "stateUpdatedAt": "2026-01-01T00:01:00.000Z"
}
```

Non-terminal `finish_job` calls do not include `finalMetrics`.

If `start_jobs` finds a non-empty fan, it refuses to reset it. Once fan is empty, `start_jobs` may begin a new lifecycle while preserving `timeline.jsonl` and `tmp/`.

## Persistent memory

The following tools are confined to the current session's `tmp/` directory:

- `job_memory_write({ path, content, mode? })`
- `job_memory_read({ path, offset?, limit? })`
- `job_memory_list({ path? })`
- `job_memory_delete({ path, recursive? })`

Use memory for evidence, intermediate data, long logs, and summaries needed across jobs. Paths must be relative; absolute paths, `..` traversal, outside symlinks, and deletion of the tmp root are rejected. Read/list output is limited to Pi's standard 2000-line/50KB context budget.

## State

`state.json` contains:

```json
{
  "state": "working",
  "detail": "Implementing the current stage",
  "fan": [
    {
      "id": "job-1",
      "kind": "job",
      "label": "Inspect the codebase",
      "startedAt": 1760000000000,
      "doneAt": 0
    }
  ],
  "tokens": 12345,
  "linkScanOffset": 4096,
  "linkScanPath": "...session.jsonl",
  "intent": "Deliver the requested change",
  "name": "Implement feature",
  "nameSource": "model",
  "sessionId": "full-session-uuid",
  "resumeSessionId": "full-session-uuid",
  "daemonShort": "first-uuid-segment",
  "cliVersion": "0.83.0",
  "cwd": "project-directory",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:01:00.000Z",
  "firstTerminalAt": null,
  "activeTimeMs": 12500
}
```

- `tokens` is the sum of assistant `usage.input + usage.output` from the current lifecycle's `createdAt` until the queue becomes `done`. Cache reads and writes, earlier conversation, and post-completion discussion are excluded; older usage records fall back to `totalTokens - cacheRead - cacheWrite`.
- `activeTimeMs` starts when `start_jobs` creates the lifecycle, counts only active agent execution, and freezes when the queue becomes `done`. Time before `start_jobs`, offline/user-wait time, and post-completion discussion are excluded. Active intervals are checkpointed on every state write, so `state.json` and `check_jobs` stay close to the live Widget value instead of updating only after settlement.
- `firstTerminalAt` records the first transition to `blocked` or `done`.
- `linkScanOffset` is the current session JSONL file size in bytes.
- Job IDs are inferred from the current fan rather than a persisted counter. A completed ID may therefore be reused later.
- The external queue is session-wide and does not rewind when `/tree` moves to an older conversation branch. While a lifecycle is active, token totals are recalculated from lifecycle start on the selected branch; completed lifecycle metrics remain frozen.

State writes use a temporary file and rename. A malformed state file produces an error and is never silently overwritten.

## Timeline

`timeline.jsonl` stores one JSON object per relevant finalized message:

```json
{"at":"2026-01-01T00:00:00.000Z","state":"working","detail":"User input","text":""}
{"at":"2026-01-01T00:01:00.000Z","state":"blocked","detail":"Waiting for a decision","text":"Assistant output"}
```

User text is stored in `detail`; finalized assistant text is stored in `text`. Thinking, tool results, images, and assistant messages containing only tool calls are not recorded. Resume listens only for new messages and does not replay old entries.

## Widget

While fan is non-empty, a widget above the editor shows:

```text
Π Implement feature... (12.5s · ↓ 12.3k tokens)
  ⠋ Inspect the codebase
  ▢ Implement the change
  ▢ Run focused tests
```

The head uses a live Braille spinner. At most five jobs are shown; additional jobs appear as `... +N pending`. Token totals use compact `k`/`M` notation. Empty fan removes the widget.

## Development

Pi loads `index.ts` directly through jiti; no compiled artifact is required.

```bash
npm ci
npm run check
npm test
pi -e ./index.ts
```

After editing an auto-discovered copy, run `/reload` in Pi.

## Release

`.github/workflows/release.yml` validates a GitHub Release after it is published:

1. Update `version` in `package.json` and commit it.
2. Create and publish a `v<version>` GitHub Release for that commit.
3. The workflow checks out the released tag, runs `npm ci`, type checking, and tests, then verifies that the tag matches `package.json`.
4. After validation, it adds the exact pinned `pi install` command to the existing Release notes and workflow summary.

The workflow does not create tags or Releases and does not publish to npm. Pi clones the selected Git tag and loads `index.ts` from `package.json`'s `pi.extensions` entry.

## License

MIT
