import { createRequire } from "node:module";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  withFileMutationQueue,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const JOBS_ROOT = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "jobs");
const WIDGET_ID = "pi-jobs";
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 100;
const MAX_LABEL_LENGTH = 500;
const MAX_MEMORY_CONTENT_LENGTH = 1_000_000;
const MEMORY_GUIDANCE =
  "Use job_memory_write for durable cross-job facts, evidence, summaries, and intermediate data; later read only the needed slices to reduce repeated token usage.";

const START_GUIDANCE = [
  "Use start_jobs when a task is complex and has multiple execution stages; simple tasks do not need a jobs queue.",
  "After start_jobs, use create_job once to enqueue the task stages from beginning to end, then work on the returned head job.",
  "Use finish_job when the current head job is complete or no longer needed, and use pend_job when the current head should be delayed.",
  "Use finish_jobs when the entire remaining queue is no longer needed, and check_jobs when the current jobs state is uncertain.",
  MEMORY_GUIDANCE,
] as const;

type JobsStateValue = "working" | "blocked" | "done";

type Job = {
  id: string;
  kind: "job";
  label: string;
  startedAt: number;
  doneAt: number;
};

type JobsState = {
  state: JobsStateValue;
  detail: string;
  fan: Job[];
  tokens: number;
  linkScanOffset: number;
  linkScanPath: string | null;
  intent: string;
  name: string;
  nameSource: "model";
  sessionId: string;
  resumeSessionId: string;
  daemonShort: string;
  cliVersion: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  firstTerminalAt: string | null;
  activeTimeMs: number;
};

type RuntimePaths = {
  sessionId: string;
  daemonShort: string;
  jobsPath: string;
  statePath: string;
  timelinePath: string;
  tmpPath: string;
};

type TimelineEntry = {
  at: string;
  state: JobsStateValue;
  detail: string;
  text: string;
};

type ToolDetails = {
  state?: JobsState;
  headJob?: Job;
  affectedJobs?: Job[];
  jobsPath: string;
  tmpPath: string;
  timelinePath: string;
  relativePath?: string;
  fullPath?: string;
  nextOffset?: number;
  hasMore?: boolean;
};

type MessageLike = {
  role?: string;
  content?: unknown;
  timestamp?: number;
  usage?: { totalTokens?: number };
};

const stateSchema = StringEnum(["working", "blocked", "done"] as const);

const startSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 500, description: "Short display name for this multi-stage task" }),
  intent: Type.String({ minLength: 1, maxLength: 2000, description: "Overall outcome the jobs queue should deliver" }),
  detail: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, description: "Current execution detail; defaults to intent" })),
});

const createSchema = Type.Object({
  jobs: Type.Array(
    Type.Object({
      label: Type.String({ minLength: 1, maxLength: MAX_LABEL_LENGTH, description: "One ordered execution stage" }),
    }),
    { minItems: 1, maxItems: 24, description: "Stages ordered from first to last" },
  ),
});

const jobIdSchema = Type.Object({
  jobId: Type.String({ minLength: 1, maxLength: 64, description: "Expected current head job ID" }),
});

const updateStateSchema = Type.Object({
  state: stateSchema,
  detail: Type.String({ minLength: 1, maxLength: 2000, description: "Current task status or blocking reason" }),
});

const finishJobsSchema = Type.Object({
  detail: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, description: "Final task detail" })),
});

const memoryWriteSchema = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 1000, description: "Path relative to this session's jobs tmp directory" }),
  content: Type.String({ maxLength: MAX_MEMORY_CONTENT_LENGTH, description: "UTF-8 content to persist" }),
  mode: Type.Optional(StringEnum(["overwrite", "append"] as const, { description: "Write mode; defaults to overwrite" })),
});

const memoryReadSchema = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 1000, description: "File path relative to this session's jobs tmp directory" }),
  offset: Type.Optional(Type.Integer({ minimum: 1, description: "First line to read, 1-based" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000, description: "Maximum lines to read" })),
});

const memoryListSchema = Type.Object({
  path: Type.Optional(Type.String({ maxLength: 1000, description: "Directory relative to tmp; omitted lists tmp root" })),
});

const memoryDeleteSchema = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 1000, description: "Path relative to this session's jobs tmp directory" }),
  recursive: Type.Optional(Type.Boolean({ description: "Required to delete a directory recursively" })),
});

function cleanText(value: string, maxLength: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function isoTime(timestamp = Date.now()): string {
  return new Date(timestamp).toISOString();
}

function resolveCliVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const entry = require.resolve("@earendil-works/pi-coding-agent");
    const packagePath = join(dirname(entry), "..", "package.json");
    const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

const CLI_VERSION = resolveCliVersion();

function isStateValue(value: unknown): value is JobsStateValue {
  return value === "working" || value === "blocked" || value === "done";
}

function validateJob(raw: unknown): Job {
  if (!raw || typeof raw !== "object") throw new Error("Invalid job entry in state.json");
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string" || value.kind !== "job" || typeof value.label !== "string") {
    throw new Error("Invalid job identity in state.json");
  }
  if (typeof value.startedAt !== "number" || typeof value.doneAt !== "number") {
    throw new Error(`Invalid timestamps for ${value.id} in state.json`);
  }
  return {
    id: value.id,
    kind: "job",
    label: value.label,
    startedAt: value.startedAt,
    doneAt: value.doneAt,
  };
}

function validateState(raw: unknown): JobsState {
  if (!raw || typeof raw !== "object") throw new Error("state.json must contain an object");
  const value = raw as Record<string, unknown>;
  const stringFields = [
    "detail",
    "intent",
    "name",
    "sessionId",
    "resumeSessionId",
    "daemonShort",
    "cliVersion",
    "cwd",
    "createdAt",
    "updatedAt",
  ] as const;
  for (const field of stringFields) {
    if (typeof value[field] !== "string") throw new Error(`Invalid ${field} in state.json`);
  }
  if (!isStateValue(value.state)) throw new Error("Invalid state in state.json");
  if (value.nameSource !== "model") throw new Error("Invalid nameSource in state.json");
  if (!Array.isArray(value.fan)) throw new Error("Invalid fan in state.json");
  if (typeof value.tokens !== "number" || !Number.isFinite(value.tokens) || value.tokens < 0) {
    throw new Error("Invalid tokens in state.json");
  }
  if (typeof value.linkScanOffset !== "number" || !Number.isFinite(value.linkScanOffset) || value.linkScanOffset < 0) {
    throw new Error("Invalid linkScanOffset in state.json");
  }
  if (value.linkScanPath !== null && typeof value.linkScanPath !== "string") {
    throw new Error("Invalid linkScanPath in state.json");
  }
  if (value.firstTerminalAt !== null && typeof value.firstTerminalAt !== "string") {
    throw new Error("Invalid firstTerminalAt in state.json");
  }
  if (typeof value.activeTimeMs !== "number" || !Number.isFinite(value.activeTimeMs) || value.activeTimeMs < 0) {
    throw new Error("Invalid activeTimeMs in state.json");
  }
  return {
    state: value.state,
    detail: value.detail as string,
    fan: value.fan.map(validateJob),
    tokens: value.tokens,
    linkScanOffset: value.linkScanOffset,
    linkScanPath: value.linkScanPath as string | null,
    intent: value.intent as string,
    name: value.name as string,
    nameSource: "model",
    sessionId: value.sessionId as string,
    resumeSessionId: value.resumeSessionId as string,
    daemonShort: value.daemonShort as string,
    cliVersion: value.cliVersion as string,
    cwd: value.cwd as string,
    createdAt: value.createdAt as string,
    updatedAt: value.updatedAt as string,
    firstTerminalAt: value.firstTerminalAt as string | null,
    activeTimeMs: value.activeTimeMs,
  };
}

function readState(path: string): JobsState {
  try {
    return validateState(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot load jobs state at ${path}: ${message}. The file was not overwritten.`);
  }
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, path);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function getMessageText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const block = item as Record<string, unknown>;
      return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
    })
    .join("\n")
    .trim();
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, milliseconds) / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const wholeSeconds = Math.floor(seconds);
  const minutes = Math.floor(wholeSeconds / 60);
  const remainder = wholeSeconds % 60;
  if (minutes < 60) return `${minutes}m ${remainder.toString().padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${(minutes % 60).toString().padStart(2, "0")}m`;
}

function isInside(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

export default function piJobs(pi: ExtensionAPI) {
  let paths: RuntimePaths | undefined;
  let state: JobsState | undefined;
  let activeStartedAt: number | undefined;
  let pendingUserMessage: TimelineEntry | undefined;
  let operationTail: Promise<void> = Promise.resolve();
  let spinnerFrame = 0;
  let spinnerTimer: ReturnType<typeof setInterval> | undefined;
  let widgetTui: { requestRender: () => void } | undefined;
  let currentContext: ExtensionContext | undefined;

  const enqueue = <T>(operation: () => Promise<T> | T): Promise<T> => {
    const run = operationTail.then(operation, operation);
    operationTail = run.then(() => undefined, () => undefined);
    return run;
  };

  const resolvePaths = (ctx: ExtensionContext): RuntimePaths => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (!sessionId) throw new Error("pi-jobs requires a session ID");
    const daemonShort = sessionId.split("-")[0] || sessionId;
    const jobsPath = join(JOBS_ROOT, daemonShort);
    return {
      sessionId,
      daemonShort,
      jobsPath,
      statePath: join(jobsPath, "state.json"),
      timelinePath: join(jobsPath, "timeline.jsonl"),
      tmpPath: join(jobsPath, "tmp"),
    };
  };

  const ensurePaths = (ctx: ExtensionContext): RuntimePaths => {
    const resolved = resolvePaths(ctx);
    if (!paths || paths.sessionId !== resolved.sessionId) paths = resolved;
    return paths;
  };

  const calculateTokens = (ctx: ExtensionContext, extraMessage?: MessageLike): number => {
    let total = 0;
    let includesExtra = false;
    for (const entry of ctx.sessionManager.getBranch() as unknown as Array<Record<string, unknown>>) {
      if (entry.type !== "message") continue;
      const message = entry.message as MessageLike | undefined;
      if (message?.role !== "assistant") continue;
      const value = message.usage?.totalTokens;
      if (typeof value === "number" && Number.isFinite(value)) total += value;
      if (
        extraMessage &&
        (message === extraMessage ||
          (message.timestamp !== undefined && extraMessage.timestamp !== undefined && message.timestamp === extraMessage.timestamp))
      ) {
        includesExtra = true;
      }
    }
    if (!includesExtra && extraMessage?.role === "assistant") {
      const value = extraMessage.usage?.totalTokens;
      if (typeof value === "number" && Number.isFinite(value)) total += value;
    }
    return total;
  };

  const refreshMetadata = (ctx: ExtensionContext, extraMessage?: MessageLike): void => {
    if (!state) return;
    const runtimePaths = ensurePaths(ctx);
    const sessionFile = ctx.sessionManager.getSessionFile();
    state.resumeSessionId = runtimePaths.sessionId;
    state.daemonShort = runtimePaths.daemonShort;
    state.cwd = ctx.cwd;
    state.cliVersion = CLI_VERSION;
    state.tokens = calculateTokens(ctx, extraMessage);
    state.linkScanPath = sessionFile ?? null;
    try {
      state.linkScanOffset = sessionFile ? statSync(sessionFile).size : 0;
    } catch {
      state.linkScanOffset = 0;
    }
  };

  const currentActiveTime = (): number => {
    if (!state) return 0;
    return state.activeTimeMs + (activeStartedAt === undefined ? 0 : Math.max(0, Date.now() - activeStartedAt));
  };

  const markTerminal = (): void => {
    if (state && state.firstTerminalAt === null) state.firstTerminalAt = isoTime();
  };

  const persistState = (ctx: ExtensionContext, extraMessage?: MessageLike): void => {
    if (!state) return;
    const runtimePaths = ensurePaths(ctx);
    refreshMetadata(ctx, extraMessage);
    state.updatedAt = isoTime();
    atomicWriteJson(runtimePaths.statePath, state);
  };

  const requestWidgetRender = (): void => {
    widgetTui?.requestRender();
  };

  const stopSpinner = (): void => {
    if (spinnerTimer) clearInterval(spinnerTimer);
    spinnerTimer = undefined;
  };

  const startSpinner = (): void => {
    if (spinnerTimer || !state?.fan.length || currentContext?.mode !== "tui") return;
    spinnerTimer = setInterval(() => {
      spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
      requestWidgetRender();
    }, SPINNER_INTERVAL_MS);
    spinnerTimer.unref?.();
  };

  const renderWidget = (theme: Theme, width: number): string[] => {
    if (!state || state.fan.length === 0) return [];
    const title = theme.fg("accent", `Π ${state.name}...`);
    const metrics = theme.fg("dim", `(${formatDuration(currentActiveTime())} · ↓ ${state.tokens.toLocaleString("en-US")} tokens)`);
    const lines = [truncateToWidth(`${title} ${metrics}`, width, "…")];
    for (const [index, job] of state.fan.slice(0, 5).entries()) {
      const line = index === 0
        ? `  ${theme.fg("accent", SPINNER_FRAMES[spinnerFrame])} ${theme.fg("accent", theme.bold(job.label))}`
        : `  ${theme.fg("muted", `▢ ${job.label}`)}`;
      lines.push(truncateToWidth(line, width, "…"));
    }
    if (state.fan.length > 5) {
      lines.push(truncateToWidth(theme.fg("dim", `   ... +${state.fan.length - 5} pending`), width, "…"));
    }
    return lines;
  };

  const syncWidget = (ctx: ExtensionContext): void => {
    currentContext = ctx;
    if (!ctx.hasUI || !state || state.fan.length === 0) {
      stopSpinner();
      widgetTui = undefined;
      if (ctx.hasUI) ctx.ui.setWidget(WIDGET_ID, undefined);
      return;
    }
    ctx.ui.setWidget(WIDGET_ID, (tui, theme) => {
      widgetTui = tui;
      return {
        render: (width: number) => renderWidget(theme, width),
        invalidate: () => {},
      };
    });
    startSpinner();
    requestWidgetRender();
  };

  const settleActiveTime = (): void => {
    if (activeStartedAt === undefined) return;
    if (state) state.activeTimeMs += Math.max(0, Date.now() - activeStartedAt);
    activeStartedAt = undefined;
  };

  const loadStateIfPresent = (ctx: ExtensionContext): JobsState | undefined => {
    const runtimePaths = ensurePaths(ctx);
    if (!existsSync(runtimePaths.statePath)) return undefined;
    return readState(runtimePaths.statePath);
  };

  const requireState = (ctx: ExtensionContext): { state: JobsState; paths: RuntimePaths } => {
    const runtimePaths = ensurePaths(ctx);
    state ??= loadStateIfPresent(ctx);
    if (!state) throw new Error("No jobs state exists for this session. Call start_jobs first.");
    return { state, paths: runtimePaths };
  };

  const appendTimeline = (entry: TimelineEntry): void => {
    if (!paths || !state) return;
    mkdirSync(paths.jobsPath, { recursive: true });
    appendFileSync(paths.timelinePath, `${JSON.stringify(entry)}\n`, "utf8");
  };

  const toolDetails = (runtimePaths: RuntimePaths, affectedJobs?: Job[]): ToolDetails => {
    const stateSnapshot = state ? structuredClone(state) : undefined;
    return {
      state: stateSnapshot,
      headJob: stateSnapshot?.fan[0],
      affectedJobs: affectedJobs?.map((job) => ({ ...job })),
      jobsPath: runtimePaths.jobsPath,
      tmpPath: runtimePaths.tmpPath,
      timelinePath: runtimePaths.timelinePath,
    };
  };

  const noRemainingText = "fan 队列已无剩余 job。";

  const nextJobNumber = (): number => {
    let maximum = 0;
    for (const job of state?.fan ?? []) {
      const match = /^job-(\d+)$/.exec(job.id);
      if (match) maximum = Math.max(maximum, Number(match[1]));
    }
    return maximum + 1;
  };

  const activateHead = (): void => {
    const head = state?.fan[0];
    if (head && head.startedAt === 0) head.startedAt = Date.now();
  };

  const normalizeMemoryInput = (value: string): string => value.replace(/^@/, "").trim();

  const resolveMemoryPath = (ctx: ExtensionContext, input: string, options: { allowRoot?: boolean; mustExist?: boolean } = {}) => {
    const runtimePaths = requireState(ctx).paths;
    const normalized = normalizeMemoryInput(input);
    if (!normalized && !options.allowRoot) throw new Error("Memory path cannot be empty");
    if (isAbsolute(normalized)) throw new Error("Memory path must be relative to the jobs tmp directory");
    const target = resolve(runtimePaths.tmpPath, normalized || ".");
    const root = resolve(runtimePaths.tmpPath);
    if (!isInside(root, target)) throw new Error("Memory path escapes the jobs tmp directory");

    let ancestor = target;
    while (!existsSync(ancestor)) {
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    if (existsSync(ancestor)) {
      const realRoot = existsSync(root) ? realpathSync(root) : root;
      const realAncestor = realpathSync(ancestor);
      if (!isInside(realRoot, realAncestor)) throw new Error("Memory path resolves through a symlink outside the jobs tmp directory");
    }
    if (options.mustExist && !existsSync(target)) throw new Error(`Memory path does not exist: ${normalized}`);
    return { runtimePaths, normalized, target, root };
  };

  pi.registerTool({
    name: "start_jobs",
    label: "Start Jobs",
    description: "Start or reset a persistent multi-stage jobs queue for the current Pi session. Use only when the task is genuinely complex and has multiple stages.",
    promptSnippet: "Start persistent job management for a complex multi-stage task",
    promptGuidelines: [...START_GUIDANCE],
    parameters: startSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return enqueue(() => {
        const runtimePaths = ensurePaths(ctx);
        const existing = existsSync(runtimePaths.statePath) ? readState(runtimePaths.statePath) : undefined;
        if (existing?.fan.length) {
          const head = existing.fan[0];
          throw new Error(`Cannot reset jobs while fan is non-empty. Current head: ${head.id} — ${head.label}. Continue it or call finish_jobs.`);
        }
        mkdirSync(runtimePaths.tmpPath, { recursive: true });
        if (!existsSync(runtimePaths.timelinePath)) writeFileSync(runtimePaths.timelinePath, "", { encoding: "utf8", mode: 0o600 });
        const now = isoTime();
        state = {
          state: "working",
          detail: cleanText(params.detail ?? params.intent, 2000),
          fan: [],
          tokens: calculateTokens(ctx),
          linkScanOffset: 0,
          linkScanPath: null,
          intent: cleanText(params.intent, 2000),
          name: cleanText(params.name, 500),
          nameSource: "model",
          sessionId: runtimePaths.sessionId,
          resumeSessionId: runtimePaths.sessionId,
          daemonShort: runtimePaths.daemonShort,
          cliVersion: CLI_VERSION,
          cwd: ctx.cwd,
          createdAt: now,
          updatedAt: now,
          firstTerminalAt: null,
          activeTimeMs: 0,
        };
        if (pendingUserMessage) {
          appendTimeline({ ...pendingUserMessage, state: "working" });
          pendingUserMessage = undefined;
        }
        persistState(ctx);
        syncWidget(ctx);
        return {
          content: [{ type: "text", text: `Jobs started at ${runtimePaths.jobsPath}. Current queue has no job; call create_job to create the ordered stages. ${noRemainingText}\nPersistent memory: ${runtimePaths.tmpPath}` }],
          details: toolDetails(runtimePaths),
        };
      });
    },
  });

  pi.registerTool({
    name: "check_jobs",
    label: "Check Jobs",
    description: "Inspect the current session's persistent jobs state and current head job without changing the queue.",
    promptSnippet: "Inspect the current persistent jobs state",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      return enqueue(() => {
        const runtimePaths = ensurePaths(ctx);
        state ??= loadStateIfPresent(ctx);
        if (!state) {
          return {
            content: [{ type: "text", text: "No jobs state exists for this session. For a complex multi-stage task, call start_jobs." }],
            details: toolDetails(runtimePaths),
          };
        }
        persistState(ctx);
        syncWidget(ctx);
        const head = state.fan[0];
        const text = head
          ? `Current head job: ${head.id} — ${head.label}\nState: ${state.state}\nDetail: ${state.detail}`
          : `State: ${state.state}\nDetail: ${state.detail}\n${noRemainingText}`;
        return { content: [{ type: "text", text }], details: toolDetails(runtimePaths) };
      });
    },
  });

  pi.registerTool({
    name: "create_job",
    label: "Create Job Queue",
    description: "Append ordered execution stages to the current jobs fan and return the current head job.",
    promptSnippet: "Create ordered stages in the persistent jobs queue",
    parameters: createSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return enqueue(() => {
        const current = requireState(ctx);
        if (current.state.state === "done") throw new Error("This jobs lifecycle is done. Call start_jobs to begin a new lifecycle before creating jobs.");
        const labels = params.jobs.map((job) => cleanText(job.label, MAX_LABEL_LENGTH));
        if (labels.some((label) => !label)) throw new Error("Each job needs a non-empty label");
        let sequence = nextJobNumber();
        const created = labels.map((label): Job => ({
          id: `job-${sequence++}`,
          kind: "job",
          label,
          startedAt: 0,
          doneAt: 0,
        }));
        current.state.fan.push(...created);
        current.state.state = "working";
        activateHead();
        persistState(ctx);
        syncWidget(ctx);
        const head = current.state.fan[0];
        return {
          content: [{ type: "text", text: `Added ${created.length} job${created.length === 1 ? "" : "s"}. Current head job: ${head.id} — ${head.label}` }],
          details: toolDetails(current.paths, created),
        };
      });
    },
  });

  pi.registerTool({
    name: "finish_job",
    label: "Finish Job",
    description: "Finish or discard the current head job, remove it from the fan, and return the next head job.",
    promptSnippet: "Finish the current head job and advance the queue",
    parameters: jobIdSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return enqueue(() => {
        const current = requireState(ctx);
        const head = current.state.fan[0];
        if (!head) throw new Error(noRemainingText);
        if (params.jobId !== head.id) throw new Error(`finish_job can only remove the current head. Current head: ${head.id} — ${head.label}`);
        const finished = { ...head, doneAt: Date.now() };
        current.state.fan.shift();
        activateHead();
        if (current.state.fan.length === 0) {
          current.state.state = "done";
          markTerminal();
        }
        persistState(ctx);
        syncWidget(ctx);
        const next = current.state.fan[0];
        const text = next
          ? `Finished ${finished.id}. Current head job: ${next.id} — ${next.label}`
          : `Finished ${finished.id}. ${noRemainingText}`;
        return { content: [{ type: "text", text }], details: toolDetails(current.paths, [finished]) };
      });
    },
  });

  pi.registerTool({
    name: "pend_job",
    label: "Pend Job",
    description: "Move the current head job to the end of the fan and return the new head job.",
    promptSnippet: "Delay the current head job by moving it to the queue tail",
    parameters: jobIdSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return enqueue(() => {
        const current = requireState(ctx);
        const head = current.state.fan[0];
        if (!head) throw new Error(noRemainingText);
        if (params.jobId !== head.id) throw new Error(`pend_job can only move the current head. Current head: ${head.id} — ${head.label}`);
        if (current.state.fan.length > 1) current.state.fan.push(current.state.fan.shift()!);
        activateHead();
        persistState(ctx);
        syncWidget(ctx);
        const next = current.state.fan[0];
        return {
          content: [{ type: "text", text: `Pended ${head.id}. Current head job: ${next.id} — ${next.label}` }],
          details: toolDetails(current.paths, [head]),
        };
      });
    },
  });

  pi.registerTool({
    name: "update_jobs_state",
    label: "Update Jobs State",
    description: "Update the overall jobs lifecycle state and its current detail without changing the fan.",
    promptSnippet: "Mark the jobs lifecycle working, blocked, or done",
    parameters: updateStateSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return enqueue(() => {
        const current = requireState(ctx);
        if (params.state === "done" && current.state.fan.length > 0) {
          throw new Error("Cannot mark jobs done while fan is non-empty. Use finish_job for each head or finish_jobs to clear the queue.");
        }
        current.state.state = params.state;
        current.state.detail = cleanText(params.detail, 2000);
        if (params.state === "blocked" || params.state === "done") markTerminal();
        persistState(ctx);
        syncWidget(ctx);
        const head = current.state.fan[0];
        const text = head
          ? `Jobs state updated to ${params.state}. Current head job: ${head.id} — ${head.label}`
          : `Jobs state updated to ${params.state}. ${noRemainingText}`;
        return { content: [{ type: "text", text }], details: toolDetails(current.paths) };
      });
    },
  });

  pi.registerTool({
    name: "finish_jobs",
    label: "Finish Jobs",
    description: "Clear the entire remaining fan and mark the jobs lifecycle done.",
    promptSnippet: "Finish or cancel the entire remaining jobs queue",
    parameters: finishJobsSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return enqueue(() => {
        const current = requireState(ctx);
        const completedAt = Date.now();
        const removed = current.state.fan.map((job) => ({ ...job, doneAt: completedAt }));
        current.state.fan = [];
        current.state.state = "done";
        if (params.detail) current.state.detail = cleanText(params.detail, 2000);
        markTerminal();
        persistState(ctx);
        syncWidget(ctx);
        return {
          content: [{ type: "text", text: `Cleared ${removed.length} job${removed.length === 1 ? "" : "s"} and marked jobs done. ${noRemainingText}` }],
          details: toolDetails(current.paths, removed),
        };
      });
    },
  });

  pi.registerTool({
    name: "job_memory_write",
    label: "Job Memory Write",
    description: "Write or append durable UTF-8 memory inside the current session's jobs tmp directory.",
    promptSnippet: "Persist durable cross-job information in the jobs tmp memory",
    promptGuidelines: [MEMORY_GUIDANCE],
    parameters: memoryWriteSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const resolvedPath = resolveMemoryPath(ctx, params.path);
      return withFileMutationQueue(resolvedPath.target, async () => {
        mkdirSync(dirname(resolvedPath.target), { recursive: true });
        const mode = params.mode ?? "overwrite";
        if (mode === "append") appendFileSync(resolvedPath.target, params.content, { encoding: "utf8", mode: 0o600 });
        else writeFileSync(resolvedPath.target, params.content, { encoding: "utf8", mode: 0o600 });
        const size = statSync(resolvedPath.target).size;
        return {
          content: [{ type: "text", text: `${mode === "append" ? "Appended" : "Wrote"} ${size} bytes to job memory: ${resolvedPath.normalized}` }],
          details: {
            ...toolDetails(resolvedPath.runtimePaths),
            relativePath: resolvedPath.normalized,
            fullPath: resolvedPath.target,
          },
        };
      });
    },
  });

  pi.registerTool({
    name: "job_memory_read",
    label: "Job Memory Read",
    description: `Read UTF-8 job memory with line offsets. Output is limited to ${DEFAULT_MAX_LINES} lines or ${Math.round(DEFAULT_MAX_BYTES / 1024)}KB.`,
    promptSnippet: "Read a needed slice from persistent jobs tmp memory",
    parameters: memoryReadSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const resolvedPath = resolveMemoryPath(ctx, params.path, { mustExist: true });
      const info = lstatSync(resolvedPath.target);
      if (!info.isFile()) throw new Error(`Job memory path is not a file: ${params.path}`);
      const allLines = readFileSync(resolvedPath.target, "utf8").split(/\r?\n/);
      if (allLines.at(-1) === "") allLines.pop();
      const offset = params.offset ?? 1;
      const limit = params.limit ?? DEFAULT_MAX_LINES;
      const selected = allLines.slice(offset - 1, offset - 1 + limit).join("\n");
      const truncation = truncateHead(selected, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
      const consumedLines = truncation.outputLines;
      const nextOffset = offset + consumedLines;
      const hasMore = nextOffset - 1 < allLines.length;
      let text = truncation.content;
      if (truncation.truncated || hasMore) {
        text += `\n\n[More job memory is available. Continue with offset=${nextOffset}. Full path: ${resolvedPath.target}]`;
      }
      return {
        content: [{ type: "text", text }],
        details: {
          ...toolDetails(resolvedPath.runtimePaths),
          relativePath: resolvedPath.normalized,
          fullPath: resolvedPath.target,
          nextOffset,
          hasMore,
        },
      };
    },
  });

  pi.registerTool({
    name: "job_memory_list",
    label: "Job Memory List",
    description: "List one directory level inside the current session's jobs tmp memory.",
    promptSnippet: "List persistent jobs tmp memory files",
    parameters: memoryListSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const resolvedPath = resolveMemoryPath(ctx, params.path ?? "", { allowRoot: true, mustExist: true });
      const directory = lstatSync(resolvedPath.target);
      if (!directory.isDirectory()) throw new Error(`Job memory path is not a directory: ${params.path ?? ""}`);
      const entries = readdirSync(resolvedPath.target, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((entry) => {
          const fullPath = join(resolvedPath.target, entry.name);
          const kind = entry.isDirectory() ? "dir" : entry.isSymbolicLink() ? "symlink" : "file";
          const size = entry.isFile() ? lstatSync(fullPath).size : 0;
          return `${kind.padEnd(7)} ${size.toString().padStart(10)} ${entry.name}`;
        });
      const output = entries.length ? entries.join("\n") : "(empty)";
      const truncation = truncateHead(output, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
      return {
        content: [{ type: "text", text: truncation.content }],
        details: {
          ...toolDetails(resolvedPath.runtimePaths),
          relativePath: resolvedPath.normalized,
          fullPath: resolvedPath.target,
        },
      };
    },
  });

  pi.registerTool({
    name: "job_memory_delete",
    label: "Job Memory Delete",
    description: "Delete a file or, with recursive=true, a directory inside the current session's jobs tmp memory.",
    promptSnippet: "Delete obsolete persistent jobs tmp memory",
    parameters: memoryDeleteSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const resolvedPath = resolveMemoryPath(ctx, params.path, { mustExist: true });
      if (resolve(resolvedPath.target) === resolve(resolvedPath.root)) throw new Error("Cannot delete the jobs tmp root");
      return withFileMutationQueue(resolvedPath.target, async () => {
        const info = lstatSync(resolvedPath.target);
        if (info.isDirectory() && !params.recursive) throw new Error("recursive=true is required to delete a job memory directory");
        rmSync(resolvedPath.target, { recursive: params.recursive ?? false, force: false });
        return {
          content: [{ type: "text", text: `Deleted job memory: ${resolvedPath.normalized}` }],
          details: {
            ...toolDetails(resolvedPath.runtimePaths),
            relativePath: resolvedPath.normalized,
            fullPath: resolvedPath.target,
          },
        };
      });
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    await enqueue(() => {
      currentContext = ctx;
      paths = resolvePaths(ctx);
      state = loadStateIfPresent(ctx);
      pendingUserMessage = undefined;
      if (state) {
        refreshMetadata(ctx);
        persistState(ctx);
      }
      syncWidget(ctx);
    });
  });

  pi.on("session_tree", async (_event, ctx) => {
    await enqueue(() => {
      currentContext = ctx;
      state ??= loadStateIfPresent(ctx);
      if (state) persistState(ctx);
      syncWidget(ctx);
    });
  });

  pi.on("agent_start", (_event, ctx) => {
    currentContext = ctx;
    activeStartedAt ??= Date.now();
    requestWidgetRender();
  });

  pi.on("agent_settled", async (_event, ctx) => {
    await enqueue(() => {
      settleActiveTime();
      if (state) persistState(ctx);
      syncWidget(ctx);
    });
  });

  pi.on("message_end", async (event: { message: MessageLike }, ctx) => {
    const message = event.message;
    if (message.role === "user") {
      const text = getMessageText(message.content);
      if (!text) return;
      const entry: TimelineEntry = {
        at: isoTime(message.timestamp),
        state: state?.state ?? "working",
        detail: text,
        text: "",
      };
      if (!state) {
        pendingUserMessage = entry;
        return;
      }
      await enqueue(() => {
        appendTimeline(entry);
        persistState(ctx);
      });
      return;
    }
    if (message.role !== "assistant") return;
    const text = getMessageText(message.content);
    await enqueue(() => {
      if (!state) return;
      if (text) {
        appendTimeline({
          at: isoTime(message.timestamp),
          state: state.state,
          detail: state.detail,
          text,
        });
      }
      persistState(ctx, message);
      syncWidget(ctx);
    });
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await enqueue(() => {
      settleActiveTime();
      if (state) persistState(ctx);
      stopSpinner();
      widgetTui = undefined;
      if (ctx.hasUI) ctx.ui.setWidget(WIDGET_ID, undefined);
    });
  });
}
