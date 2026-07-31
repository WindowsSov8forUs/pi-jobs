import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const testRoot = mkdtempSync(join(tmpdir(), "pi-jobs-test-"));
const agentDir = join(testRoot, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;

function firstExisting(candidates, label) {
  const match = candidates.filter(Boolean).find((candidate) => existsSync(candidate));
  if (!match) throw new Error(`Cannot locate ${label}. Checked: ${candidates.filter(Boolean).join(", ")}`);
  return match;
}

function findAgentRoot() {
  const candidates = [
    join(here, "node_modules", "@earendil-works", "pi-coding-agent"),
    process.env.APPDATA && join(process.env.APPDATA, "npm", "node_modules", "@earendil-works", "pi-coding-agent"),
    join(dirname(process.execPath), "node_modules", "@earendil-works", "pi-coding-agent"),
  ].filter(Boolean);
  return firstExisting(candidates.map((candidate) => join(candidate, "package.json")), "@earendil-works/pi-coding-agent package.json")
    .replace(/[\\/]package\.json$/, "");
}

const agentRoot = findAgentRoot();
const agentRequire = createRequire(pathToFileURL(join(agentRoot, "package.json")));
const projectRequire = createRequire(import.meta.url);
const jitiEntry = firstExisting([
  join(agentRoot, "node_modules", "jiti", "lib", "jiti.mjs"),
  join(here, "node_modules", "jiti", "lib", "jiti.mjs"),
], "jiti");
const piAiEntry = firstExisting([
  join(agentRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "index.js"),
  join(here, "node_modules", "@earendil-works", "pi-ai", "dist", "index.js"),
], "@earendil-works/pi-ai");
const piTuiEntry = firstExisting([
  join(agentRoot, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js"),
  join(here, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js"),
], "@earendil-works/pi-tui");
let typeboxEntry;
try {
  typeboxEntry = projectRequire.resolve("typebox");
} catch {
  typeboxEntry = agentRequire.resolve("typebox");
}
const { createJiti } = await import(pathToFileURL(jitiEntry));
const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-coding-agent": join(agentRoot, "dist", "index.js"),
    "@earendil-works/pi-ai": piAiEntry,
    "@earendil-works/pi-tui": piTuiEntry,
    typebox: typeboxEntry,
  },
});

const tools = new Map();
const handlers = new Map();
const widgets = new Map();
const pi = {
  registerTool(definition) {
    assert.ok(!tools.has(definition.name), `duplicate tool ${definition.name}`);
    tools.set(definition.name, definition);
  },
  on(name, handler) {
    const list = handlers.get(name) ?? [];
    list.push(handler);
    handlers.set(name, list);
  },
};

const sessionId = "abcdef12-3456-7890-abcd-ef1234567890";
const sessionFile = join(testRoot, "session.jsonl");
writeFileSync(sessionFile, '{"type":"session"}\n', "utf8");
let branch = [];
let widgetFactory;
const theme = {
  fg(color, text) {
    return `<${color}>${text}</${color}>`;
  },
  bold(text) {
    return `<bold>${text}</bold>`;
  },
};
const ctx = {
  cwd: join(testRoot, "workspace"),
  hasUI: true,
  mode: "tui",
  model: { provider: "test", id: "model" },
  thinkingLevel: "high",
  sessionManager: {
    getSessionId: () => sessionId,
    getSessionFile: () => sessionFile,
    getBranch: () => branch,
  },
  ui: {
    setWidget(id, value) {
      if (value === undefined) {
        widgets.delete(id);
        widgetFactory = undefined;
      } else {
        widgets.set(id, value);
        widgetFactory = value;
      }
    },
  },
};

const runtime = {
  renderRequests: 0,
  requestRender() {
    this.renderRequests += 1;
  },
};

const emit = async (name, event = {}, eventCtx = ctx) => {
  for (const handler of handlers.get(name) ?? []) await handler(event, eventCtx);
};

const execute = async (name, params = {}, executionCtx = ctx) => {
  const tool = tools.get(name);
  assert.ok(tool, `tool ${name} should be registered`);
  return tool.execute(`call-${name}`, params, undefined, undefined, executionCtx);
};

const readState = () => JSON.parse(readFileSync(join(agentDir, "jobs", "abcdef12", "state.json"), "utf8"));
const readTimeline = () => readFileSync(join(agentDir, "jobs", "abcdef12", "timeline.jsonl"), "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const realDateNow = Date.now;
let now = 100_000;
Date.now = () => now;

try {
  const extension = await jiti.import(join(here, "index.ts"), { default: true });
  extension(pi);

  assert.deepEqual(
    [...tools.keys()].sort(),
    [
      "check_jobs",
      "create_job",
      "finish_job",
      "finish_jobs",
      "job_memory_delete",
      "job_memory_list",
      "job_memory_read",
      "job_memory_write",
      "pend_job",
      "start_jobs",
      "update_jobs_state",
    ],
  );
  assert.ok(handlers.has("session_start"));
  assert.ok(handlers.has("message_end"));
  assert.ok(handlers.has("agent_settled"));

  await emit("session_start", { reason: "startup" });
  assert.equal(existsSync(join(agentDir, "jobs")), false, "session_start must not create runtime data before start_jobs");

  await emit("message_end", {
    message: { role: "user", content: [{ type: "text", text: "Implement this multi-stage feature" }], timestamp: 99_000 },
  });
  assert.equal(existsSync(join(agentDir, "jobs")), false, "buffering the triggering user message must not create files");

  await emit("agent_start");
  now = 101_000;
  const started = await execute("start_jobs", {
    name: "Feature rollout",
    intent: "Implement and verify the feature",
    detail: "Planning stages",
  });
  const jobsPath = join(agentDir, "jobs", "abcdef12");
  assert.equal(started.details.jobsPath, jobsPath);
  assert.ok(existsSync(join(jobsPath, "state.json")));
  assert.ok(existsSync(join(jobsPath, "timeline.jsonl")));
  assert.ok(existsSync(join(jobsPath, "tmp")));
  assert.equal(widgets.has("pi-jobs"), false, "empty fan must hide the widget");

  let state = readState();
  assert.equal(state.state, "working");
  assert.equal(state.name, "Feature rollout");
  assert.equal(state.daemonShort, "abcdef12");
  assert.equal(state.sessionId, sessionId);
  assert.equal(state.resumeSessionId, sessionId);
  assert.equal(state.linkScanPath, sessionFile);
  assert.equal(state.linkScanOffset, statSync(sessionFile).size);
  assert.equal(state.activeTimeMs, 0, "jobs timing starts at start_jobs, excluding the earlier part of the agent run");
  assert.equal("inFlight" in state, false);
  assert.match(state.cliVersion, /^(unknown|\d+\.\d+\.\d+)/);
  assert.deepEqual(readTimeline(), [{
    at: new Date(99_000).toISOString(),
    state: "working",
    detail: "Implement this multi-stage feature",
    text: "",
  }]);

  const created = await execute("create_job", {
    jobs: [
      { label: "Inspect code" },
      { label: "Design changes" },
      { label: "Implement changes" },
      { label: "Run focused tests" },
      { label: "Run broad tests" },
      { label: "Document results" },
    ],
  });
  assert.equal(created.details.headJob.id, "job-1");
  state = readState();
  assert.deepEqual(state.fan.map((job) => job.id), ["job-1", "job-2", "job-3", "job-4", "job-5", "job-6"]);
  assert.equal(state.fan[0].startedAt, now);
  assert.equal(state.fan[1].startedAt, 0);
  assert.ok(widgetFactory, "non-empty fan must install the widget");
  const component = widgetFactory(runtime, theme);
  const widgetLines = component.render(200);
  assert.equal(widgetLines.length, 7, "title, five jobs, and overflow should render");
  assert.match(widgetLines[0], /Π Feature rollout/);
  assert.match(widgetLines[0], /↓ 0 tokens/);
  assert.match(widgetLines[1], /⠋/);
  assert.match(widgetLines[1], /Inspect code/);
  assert.match(widgetLines[6], /\+1 pending/);

  await assert.rejects(
    execute("start_jobs", { name: "Wrong reset", intent: "Must fail" }),
    /Cannot reset jobs while fan is non-empty.*job-1/,
  );
  await assert.rejects(execute("finish_job", { jobId: "job-3" }), /only remove the current head/);
  await assert.rejects(execute("pend_job", { jobId: "job-3" }), /only move the current head/);
  await assert.rejects(
    execute("update_jobs_state", { state: "done", detail: "Too early" }),
    /fan is non-empty/,
  );

  now = 102_000;
  const pended = await execute("pend_job", { jobId: "job-1" });
  assert.equal(pended.details.headJob.id, "job-2");
  state = readState();
  assert.deepEqual(state.fan.map((job) => job.id), ["job-2", "job-3", "job-4", "job-5", "job-6", "job-1"]);
  assert.equal(state.fan[0].startedAt, now);
  assert.equal(state.fan[5].startedAt, 101_000, "pended job keeps its first start time");

  now = 103_000;
  const finished = await execute("finish_job", { jobId: "job-2" });
  assert.equal(finished.details.affectedJobs[0].doneAt, now);
  assert.equal(finished.details.headJob.id, "job-3");

  const blocked = await execute("update_jobs_state", { state: "blocked", detail: "Waiting for approval" });
  assert.equal(blocked.details.state.state, "blocked");
  const firstTerminalAt = blocked.details.state.firstTerminalAt;
  assert.ok(firstTerminalAt);
  now = 104_000;
  await execute("update_jobs_state", { state: "working", detail: "Approval received" });
  assert.equal(readState().firstTerminalAt, firstTerminalAt, "first terminal timestamp must not be overwritten");

  await execute("job_memory_write", { path: "notes/context.md", content: "alpha\nbeta\n" });
  await execute("job_memory_write", { path: "notes/context.md", content: "gamma\n", mode: "append" });
  const memory = await execute("job_memory_read", { path: "notes/context.md", offset: 2, limit: 2 });
  assert.equal(memory.content[0].text, "beta\ngamma");
  const memoryList = await execute("job_memory_list", { path: "notes" });
  assert.match(memoryList.content[0].text, /context\.md/);
  await assert.rejects(execute("job_memory_write", { path: "../escape.txt", content: "bad" }), /escapes/);
  await assert.rejects(execute("job_memory_read", { path: join(testRoot, "outside.txt") }), /must be relative/);

  const outsideDir = join(testRoot, "outside");
  mkdirSync(outsideDir);
  let symlinkCreated = false;
  try {
    symlinkSync(outsideDir, join(jobsPath, "tmp", "outside-link"), "junction");
    symlinkCreated = true;
  } catch {
    // Windows may require Developer Mode or elevated permissions for symlinks.
  }
  if (symlinkCreated) {
    await assert.rejects(
      execute("job_memory_write", { path: "outside-link/escape.txt", content: "bad" }),
      /symlink outside/,
    );
  }

  branch = [{
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "A checkpoint" }],
      timestamp: 104_500,
      usage: { totalTokens: 112_345, input: 12_000, output: 345, cacheRead: 100_000, cacheWrite: 0 },
    },
  }];
  await emit("message_end", { message: branch[0].message });
  state = readState();
  assert.equal(state.tokens, 12_345, "tokens include only input and output, excluding cache usage");
  const tokenWidget = widgetFactory(runtime, theme).render(200);
  assert.match(tokenWidget[0], /↓ 12\.3k tokens/, "widget uses compact k formatting");
  let timeline = readTimeline();
  assert.equal(timeline.at(-1).text, "A checkpoint");
  assert.equal(timeline.at(-1).detail, "Approval received");

  await emit("message_end", {
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "hidden" }, { type: "toolCall", id: "x", name: "read", arguments: {} }],
      timestamp: 104_600,
      usage: { totalTokens: 30, input: 2, output: 3, cacheRead: 25, cacheWrite: 0 },
    },
  });
  timeline = readTimeline();
  assert.equal(timeline.length, 2, "thinking/tool-only assistant message must not enter timeline");
  assert.equal(readState().tokens, 12_350, "an assistant event not yet in branch is included once without cache tokens");

  branch = [{
    type: "message",
    message: { role: "assistant", content: [], timestamp: 104_700, usage: { totalTokens: 7, input: 4, output: 1, cacheRead: 2, cacheWrite: 0 } },
  }];
  writeFileSync(sessionFile, '{"type":"session"}\n{"type":"message"}\n', "utf8");
  await emit("session_tree");
  state = readState();
  assert.equal(state.tokens, 5, "tree navigation recalculates non-cache branch token totals");
  assert.equal(state.linkScanOffset, statSync(sessionFile).size);

  branch = [{
    type: "message",
    message: {
      role: "assistant",
      content: [],
      timestamp: 104_800,
      usage: { totalTokens: 2_234_567, input: 1_234_000, output: 567, cacheRead: 1_000_000, cacheWrite: 0 },
    },
  }];
  await emit("session_tree");
  state = readState();
  assert.equal(state.tokens, 1_234_567);
  assert.match(widgetFactory(runtime, theme).render(200)[0], /↓ 1\.2M tokens/, "widget uses compact M formatting");

  now = 106_000;
  await emit("agent_settled");
  state = readState();
  assert.equal(state.activeTimeMs, 5_000, "active time counts only from start_jobs through settled");

  const cleared = await execute("finish_jobs", { detail: "No remaining stages are needed" });
  assert.match(cleared.content[0].text, /fan 队列已无剩余 job/);
  assert.equal(cleared.details.headJob, undefined);
  assert.equal(readState().fan.length, 0);
  assert.equal(readState().state, "done");
  assert.equal(widgets.has("pi-jobs"), false);
  const clearedAgain = await execute("finish_jobs", {});
  assert.match(clearedAgain.content[0].text, /fan 队列已无剩余 job/);
  const frozenState = readState();
  branch = [{
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Post-completion discussion" }],
      timestamp: 106_500,
      usage: { totalTokens: 500_000, input: 200_000, output: 10_000, cacheRead: 290_000, cacheWrite: 0 },
    },
  }];
  await emit("message_end", { message: branch[0].message });
  assert.equal(readState().tokens, frozenState.tokens, "done lifecycle freezes token totals against later conversation");
  assert.equal(readState().activeTimeMs, frozenState.activeTimeMs, "done lifecycle freezes active time");
  await assert.rejects(
    execute("update_jobs_state", { state: "working", detail: "Must restart" }),
    /Call start_jobs to begin a new lifecycle/,
  );

  const timelineBeforeReset = readFileSync(join(jobsPath, "timeline.jsonl"), "utf8");
  const memoryBeforeReset = readFileSync(join(jobsPath, "tmp", "notes", "context.md"), "utf8");
  now = 107_000;
  await execute("start_jobs", { name: "Second lifecycle", intent: "Verify restart behavior" });
  state = readState();
  assert.equal(state.name, "Second lifecycle");
  assert.equal(state.state, "working");
  assert.equal(state.activeTimeMs, 0);
  assert.equal(state.tokens, 0, "new lifecycle excludes assistant usage from before its createdAt");
  assert.equal(state.firstTerminalAt, null);
  assert.equal(readFileSync(join(jobsPath, "timeline.jsonl"), "utf8"), timelineBeforeReset, "reset preserves timeline");
  assert.equal(readFileSync(join(jobsPath, "tmp", "notes", "context.md"), "utf8"), memoryBeforeReset, "reset preserves tmp memory");

  await Promise.all([
    execute("create_job", { jobs: [{ label: "Parallel A" }] }),
    execute("create_job", { jobs: [{ label: "Parallel B" }] }),
  ]);
  state = readState();
  assert.deepEqual(state.fan.map((job) => job.id), ["job-1", "job-2"], "parallel mutations must serialize without losing jobs");

  const checked = await execute("check_jobs");
  assert.equal(checked.details.headJob.id, "job-1");
  assert.equal(checked.details.state.fan.length, 2);

  await execute("job_memory_delete", { path: "notes/context.md" });
  assert.equal(existsSync(join(jobsPath, "tmp", "notes", "context.md")), false);
  await assert.rejects(execute("job_memory_delete", { path: "notes" }), /recursive=true/);
  await execute("job_memory_delete", { path: "notes", recursive: true });
  await assert.rejects(execute("job_memory_delete", { path: ".", recursive: true }), /Cannot delete the jobs tmp root/);

  await emit("session_shutdown", { reason: "reload" });
  const timelineCount = readTimeline().length;
  await emit("session_start", { reason: "reload" });
  assert.equal(readTimeline().length, timelineCount, "resume/reload must not replay timeline messages");
  assert.ok(widgets.has("pi-jobs"), "resume restores non-empty fan widget");

  const savedState = readFileSync(join(jobsPath, "state.json"), "utf8");
  writeFileSync(join(jobsPath, "state.json"), "{invalid json", "utf8");
  const secondTools = new Map();
  const secondHandlers = new Map();
  const secondPi = {
    registerTool(definition) {
      secondTools.set(definition.name, definition);
    },
    on(name, handler) {
      const list = secondHandlers.get(name) ?? [];
      list.push(handler);
      secondHandlers.set(name, list);
    },
  };
  extension(secondPi);
  await assert.rejects(
    Promise.all((secondHandlers.get("session_start") ?? []).map((handler) => handler({ reason: "resume" }, ctx))),
    /Cannot load jobs state.*not overwritten/,
  );
  assert.equal(readFileSync(join(jobsPath, "state.json"), "utf8"), "{invalid json", "corrupt state must remain untouched");
  writeFileSync(join(jobsPath, "state.json"), savedState, "utf8");

  console.log("pi-jobs regression tests passed");
} finally {
  Date.now = realDateNow;
  rmSync(testRoot, { recursive: true, force: true });
}
