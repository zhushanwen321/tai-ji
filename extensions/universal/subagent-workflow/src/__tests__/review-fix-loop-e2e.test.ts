/**
 * review-fix-loop E2E（真实 worker thread + 场景化 mock LLM runner）
 *
 * §7.2 行为/E2E 测试（设计文档 7.2 三条）：
 *   1. R2 prompt 对账段断言 + defer 跨轮传递 mock 剧本（E2E-1）
 *   2. skipCleanAgents 语义 + fixAgent 参数接受（E2E-2）
 *   3. 渲染 gate：非 clean 终止 message 的 [UNRESOLVED] 透出 + ES3 硬校验拦截（E2E-3）
 *   4. M2 回归：全 fixed + 新发现 → reconcile 门控（reconCount）+ 新发现 merge 独立执行（E2E-4）
 *   5. M4 回归：recheckAfterFix=true → 全批重派 + clean agent 走 scoped 分支（E2E-5）
 *   6. F1 回归：doc-reviewer-only 批（reconciliation 恒空）→ merge 重新报告转换 → needs-redesign（E2E-6）
 *   另含 fail-fast describe（结构化返回失败立即终判，W1-W6；弱格式降级通道已整体拆除）。
 *
 * 与 workflows-e2e.test.ts 同模式：真实 runAndWait + 真实 worker thread +
 * 唯一 mock 是 deps.runner（AgentRunner）。runner 按调用分流：
 *   - schema 含 must_fix_ids → aggregator
 *   - schema 含 fixed_count → fix
 *   - 其余 → review agent
 * 剧本按调用序返回固定结构化数据；R2 review 会检查 prompt 内容（defer 跨轮传递验证）。
 *
 * 已知限制：批内 review 调用顺序不保证——剧本不依赖具体 agent 顺序
 * （E2E-2 只断言调用总数，R1 中先到者 dirty 后到者 clean 均可）。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { JsonlRunStore } from "../jsonl-run-store.ts";
import { parseResourceMeta } from "@zhushanwen/subagent-core";
import { normalizeRef } from "@zhushanwen/subagent-core/shared/agent-ref.ts";
import { type LauncherDeps, runAndWait } from "@zhushanwen/subagent-core";
import type { LifecycleDeps } from "@zhushanwen/subagent-core";
import type { AgentRunner } from "@zhushanwen/subagent-core/orchestration/models/ports.ts";
import type { AgentResult, AgentUsage } from "@zhushanwen/subagent-core/orchestration/models/types.ts";
import {
  type WorkflowMeta,
  WorkflowScript,
  type WorkflowSource,
} from "@zhushanwen/subagent-core/orchestration/models/workflow-script.ts";
import type { WorkflowScriptRegistry } from "@zhushanwen/subagent-core";
import { WorkerHostImpl } from "@zhushanwen/subagent-core";
// fail-fast 用例：F-1 形态 error 哨兵的引擎 SSOT 常量（output-collector 构造 error 时
// 开头拼接）——结构化返回失败已无降级通道，一切 error 哨兵都走终判；此常量只用于
// 构造「真实引擎确定性失败形态」的 error 文本。
import { DETERMINISTIC_SCHEMA_FAILURE_PREFIX } from "@zhushanwen/pi-subagent-cli";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_DIR = join(__dirname, "..", "..", "node_modules", "@zhushanwen", "subagent-core", "workflows");
const wf = (name: string): string => join(WORKFLOWS_DIR, name + ".js");

// agentMd 创建真实临时 fixture .md（e2e 自包含，不依赖包内 agents/ 清单）。
// R3 启动期 stat 校验要求路径真实存在；fixtureDir 在 beforeEach 创建。
let fixtureDir: string;
const agentMd = (name: string): string => {
  const p = join(fixtureDir, name + ".md");
  writeFileSync(p, `---\nname: ${name}\ndescription: "${name} fixture"\n---\nbody`, "utf-8");
  return p;
};

let sessionDir: string;
let createdStores: JsonlRunStore[] = [];

const MOCK_USAGE: AgentUsage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  contextTokens: 15,
  turns: 1,
};

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  oneOf?: JsonSchema[];
  required?: string[];
};

/**
 * 轻量 schema 契约校验（m8）：递归校验 parsed 是否符合 opts.schema，防止 mock runner
 * 绕过权威 ajv 校验掩盖「实现与契约脱节」（severity 对象被拒、report_content 丢失等
 * 事故）。支持 type/oneOf/required/properties/items；description 等无关键忽略，
 * 多出的属性不报错。校验失败抛 Error（测试立即失败，message 含 SCHEMA CONTRACT VIOLATION）。
 */
function miniValidator(schema: unknown, value: unknown, path: string): void {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return; // 无契约不校验
  const s = schema as JsonSchema;
  if (Array.isArray(s.oneOf) && s.oneOf.length > 0) {
    const anyPass = s.oneOf.some((alt) => {
      try {
        miniValidator(alt, value, path);
        return true;
      } catch {
        return false;
      }
    });
    if (!anyPass) throw new Error(`SCHEMA CONTRACT VIOLATION: ${path} (no oneOf branch matched)`);
    return;
  }
  if (s.type) {
    // rfl C5：JSON Schema union type（如 total: ["number", "null"]）——任一分支匹配即过
    const types = Array.isArray(s.type) ? s.type : [s.type];
    const ok = types.some((t) =>
      (t === "string" && typeof value === "string") ||
      (t === "number" && typeof value === "number") ||
      (t === "integer" && typeof value === "number" && Number.isInteger(value)) ||
      (t === "boolean" && typeof value === "boolean") ||
      (t === "null" && value === null) ||
      (t === "object" && value !== null && typeof value === "object" && !Array.isArray(value)) ||
      (t === "array" && Array.isArray(value)));
    if (!ok) throw new Error(`SCHEMA CONTRACT VIOLATION: ${path} (expected ${JSON.stringify(s.type)})`);
  }
  const rec = value as Record<string, unknown> | null;
  if (Array.isArray(s.required) && rec !== null && typeof rec === "object") {
    for (const key of s.required) {
      if (!(key in rec)) throw new Error(`SCHEMA CONTRACT VIOLATION: ${path}.${key} (missing required property)`);
    }
  }
  if (s.properties && rec !== null && typeof rec === "object" && !Array.isArray(rec)) {
    for (const [key, sub] of Object.entries(s.properties)) {
      if (rec[key] !== undefined) miniValidator(sub, rec[key], `${path}.${key}`);
    }
  }
  if (s.items && Array.isArray(value)) {
    value.forEach((item, i) => miniValidator(s.items, item, `${path}[${i}]`));
  }
}

/** 按 schema 形状识别调用阶段（review / aggregator / fix）。 */
function classifyCall(opts: { schema?: unknown }): "review" | "aggregate" | "fix" {
  const props = (opts.schema as JsonSchema | undefined)?.properties ?? {};
  if ("must_fix_ids" in props) return "aggregate";
  if ("fixed_count" in props) return "fix";
  return "review";
}

/**
 * 对 worker 返回的不可信 scriptResult 做最小运行时形状校验（S-16）：
 * workflow 脚本是 JS（无 TS 类型），scriptResult 形状不受静态约束，直接类型断言
 * 会在结构漂移时掩盖真实形状。guard 校验 terminated 为 string（所有终止路径必含），
 * 再返回带可选字段的 view；其余字段由断言侧校验存在性。
 */
function assertScriptOutcome(scriptResult: unknown): {
  terminated: string;
  totalFixed?: number;
  message?: string;
  runDir?: string;
} {
  const raw = scriptResult as Record<string, unknown> | null | undefined;
  if (raw === null || typeof raw !== "object") {
    throw new Error(`scriptResult 缺失或非对象（worker 输出形状漂移）: ${JSON.stringify(scriptResult)}`);
  }
  if (typeof raw.terminated !== "string") {
    throw new Error(`scriptResult.terminated 非 string（worker 输出形状漂移）: ${JSON.stringify(raw.terminated)}`);
  }
  return raw as { terminated: string; totalFixed?: number; message?: string; runDir?: string };
}

/**
 * 剧本单次调用返回值：正常结构化数据 / __invalidOutput 哨兵（违约 value）/
 * __error 哨兵（returnMeta error 形态——fail-fast 用例：F-1 deterministic 前缀
 * 或 AgentRegistry not found 等，一切 error 形态都立即终判）。
 */
type ScenarioReturn =
  | Record<string, unknown>
  | { __invalidOutput: unknown }
  | { __error: string; __failureKind?: string };

/**
 * 剧本哨兵解包：__error = AgentResult 带 error、parsedOutput 缺席（脚本 returnMeta
 * 侧收到 {value: content, error}——failFastAgent 包装把 error 信封转为 reject，
 * Promise.all 立即收敛落终判）。__error 默认带
 * failureKind="schema_deterministic"（对齐真实 F-1 形态：引擎产出侧 output-collector
 * 构造 error 时同步标记，execute-agent-call 分诊不重试、error 原样透传到脚本层——
 * returnMeta 只挑 error 字段，脚本只见字符串）；显式传 __failureKind: undefined 形态
 * （如 AgentRegistry not found）走引擎可重试路径（重试耗尽后透传）。__invalidOutput
 * = value 刻意违约（既有 F2/F3 语义）。两者都跳过 miniValidator（契约校验防的是
 * mock 无意脱节，刻意违约剧本必须绕过）。
 */
function unwrapScenario(raw: ScenarioReturn): {
  parsed: unknown;
  error: string | undefined;
  failureKind: string | undefined;
  skipContractCheck: boolean;
} {
  if (raw && typeof raw === "object" && "__error" in raw) {
    // 默认 schema_deterministic（F-1 真实形态，不重试直达脚本层）；非确定性场景
    // 显式传其他值（如 "unknown"）——execute-agent-call 分诊只认 stale_context /
    // schema_deterministic，其余落可重试路径（幂等剧本重试耗尽后透传 error）
    return {
      parsed: undefined,
      error: String((raw as { __error: unknown }).__error),
      failureKind: (raw as { __error: string; __failureKind?: string }).__failureKind ?? "schema_deterministic",
      skipContractCheck: true,
    };
  }
  if (raw && typeof raw === "object" && "__invalidOutput" in raw) {
    return { parsed: (raw as { __invalidOutput: unknown }).__invalidOutput, error: undefined, failureKind: undefined, skipContractCheck: true };
  }
  return { parsed: raw, error: undefined, failureKind: undefined, skipContractCheck: false };
}

interface Scenario {
  /** review 调用序 → 返回数据生成器；R2+ 回调收到 prompt 文本（可用于对账/传递断言）。
   * 返回 { __invalidOutput: value } 哨兵 = 模拟「reviewer 输出无效」（F3/W2 锁定用例，
   * 语义同 aggregate 哨兵）；返回 { __error } 哨兵 = 模拟结构化失败（fail-fast 用例）。 */
  review: Array<(prompt: string) => ScenarioReturn>;
  /**
   * aggregate 剧本（回调收到 prompt 文本）。返回 { __invalidOutput: value } 哨兵 =
   * 模拟「aggregator 输出无效」（真实 LLM 违约场景，W4 e2e）：runner 解包后直接返回
   * value 并跳过 miniValidator——契约校验防的是 mock 无意脱节，刻意违约剧本必须绕过。
   */
  aggregate: (prompt: string) => ScenarioReturn;
  /** fix 剧本；回调收到 prompt 文本（fail-fast / 分组用例按 "group G<k>/<n>" header 分流）。 */
  fix: (prompt: string) => ScenarioReturn;
}

/**
 * 场景化 mock runner：记录每次调用的 prompt 与分类，按剧本返回。
 * R2 review 调用（剧本元素）若返回含 must_fix: 9 表示"断言失败"信号（测试可见）。
 */
function makeScenarioRunner(scenario: Scenario) {
  const reviewCalls: Array<{ prompt: string; result: Record<string, unknown> }> = [];
  const calls: Array<{ kind: "review" | "aggregate" | "fix"; prompt: string; agent?: string; schema?: unknown; model?: string }> = [];
  const run = vi.fn(async (opts: { prompt?: string; schema?: unknown; agent?: string; model?: string }): Promise<AgentResult> => {
    const kind = classifyCall(opts);
    const prompt = opts.prompt ?? "";
    // m5：记录 agent 字段（review/fix 派发验证）。内置名（reviewer/doc-reviewer）走
    // def.name，自定义 .md agent 为 undefined——只断言 fix 调用的（fixAgent 派发）。
    // rfl B6：记录 opts.schema（aggregatorSchema 扩展断言——防 schema 与 prompt 脱节）。
    // rfl C5：记录 opts.model（aggregatorModel 降档断言）。
    calls.push({ kind, prompt, agent: opts.agent, schema: opts.schema, model: opts.model });
    let parsed: unknown = null;
    // F2 e2e：__invalidOutput 哨兵 = 刻意模拟 aggregator 违约输出（缺 must_fix 等），
    // miniValidator 对故意无效无校验意义，跳过（防契约校验拦截违约剧本）；
    // fail-fast 用例：__error 哨兵 = returnMeta error 形态（F-1 前缀 / 非确定性 error），
    // failureKind 对齐引擎产出侧标记（execute-agent-call 分诊依据）。
    let error: string | undefined;
    let failureKind: string | undefined;
    let skipContractCheck = false;
    if (kind === "review") {
      const idx = reviewCalls.length;
      const gen = scenario.review[Math.min(idx, scenario.review.length - 1)];
      const result = gen(prompt);
      reviewCalls.push({ prompt, result });
      // F3 锁定用例：review 剧本同样支持 __invalidOutput 哨兵——模拟 reviewer 违约
      // 输出（缺 must_fix），绕过 miniValidator（契约校验防的是 mock 无意脱节）。
      const unwrapped = unwrapScenario(result);
      parsed = unwrapped.parsed; error = unwrapped.error; failureKind = unwrapped.failureKind; skipContractCheck = unwrapped.skipContractCheck;
    } else if (kind === "aggregate") {
      const unwrapped = unwrapScenario(scenario.aggregate(prompt));
      parsed = unwrapped.parsed; error = unwrapped.error; failureKind = unwrapped.failureKind; skipContractCheck = unwrapped.skipContractCheck;
    } else {
      const unwrapped = unwrapScenario(scenario.fix(prompt));
      parsed = unwrapped.parsed; error = unwrapped.error; failureKind = unwrapped.failureKind; skipContractCheck = unwrapped.skipContractCheck;
    }
    // m8：schema 契约校验——mock 返回的 parsedOutput 必须符合 workflow 声明的权威 schema
    // （防止未来 schema 收紧时 E2E 仍绿）。校验失败抛错让测试立即失败。
    if (!skipContractCheck) miniValidator(opts.schema, parsed, "parsedOutput");
    // rfl 仪表（T1）：sessionId 逐调用编号——A6 断言 calls[].sessionId 与调用序对应
    return {
      content: "mock",
      parsedOutput: parsed,
      usage: MOCK_USAGE,
      durationMs: 1,
      sessionId: "sess-e2e-" + (calls.length - 1),
      error,
      ...(failureKind !== undefined ? { failureKind } : {}),
    };
  });
  return {
    run,
    stats: () => ({
      reviewCalls,
      kinds: calls.map((c) => c.kind),
      prompts: calls.map((c) => c.prompt),
      agents: calls.map((c) => c.agent),
      schemas: calls.map((c) => c.schema),
      models: calls.map((c) => c.model),
    }),
  };
}

// ── registry（与 workflows-e2e.test.ts 同模式：读文件构造 WorkflowScript） ──

function extractMeta(source: string, fallbackName: string): WorkflowMeta {
  // m2 exec-review MINOR-1：旧 const meta regex + new Function 随 m2 迁移已失效，
  // 改调 IF1 parseResourceMeta（与 workflows-e2e.test 一致）。
  const meta = parseResourceMeta(source, "workflow");
  if (meta && meta.kind === "workflow") return meta;
  return { kind: "workflow", name: fallbackName, description: "", phases: [] };
}

function loadWorkflowsFromDir(dir: string): Map<string, WorkflowScript> {
  const scripts = new Map<string, WorkflowScript>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".js")) continue;
    const fullPath = join(dir, file);
    const sourceCode = readFileSync(fullPath, "utf-8");
    const stem = file.replace(/\.js$/, "");
    const meta = extractMeta(sourceCode, stem);
    const source: WorkflowSource = "saved";
    scripts.set(
      meta.name,
      new WorkflowScript({
        name: meta.name,
        source,
        path: fullPath,
        sourceCode,
        meta,
        available: true,
      }),
    );
  }
  return scripts;
}

function makeRegistry(scripts: Map<string, WorkflowScript>): WorkflowScriptRegistry {
  return {
    get: async (name: string) => scripts.get(name),
    // S2：按路径加载（任意路径 .js）——路径未预扫则直接读文件
    getPath: async (ref: string) => {
      const normalized = normalizeRef(ref, ".js");
      if (normalized === null) return undefined;
      for (const script of scripts.values()) {
        if (script.path === normalized) return script;
      }
      try {
        const sourceCode = readFileSync(normalized, "utf-8");
        const stem = basename(normalized, ".js");
        const meta = extractMeta(sourceCode, stem);
        return new WorkflowScript({
          name: meta.name,
          source: "saved",
          path: normalized,
          sourceCode,
          meta,
          available: true,
        });
      } catch {
        return undefined;
      }
    },
    loadAll: async () => Array.from(scripts.values()),
    invalidate: () => {},
  };
}

function makeDeps(runner: AgentRunner): LauncherDeps {
  const scripts = loadWorkflowsFromDir(WORKFLOWS_DIR);
  const registry = makeRegistry(scripts);
  const store = new JsonlRunStore({ sessionDir });
  createdStores.push(store);
  const base: LifecycleDeps = {
    store,
    workerHost: new WorkerHostImpl(),
    runner,
    runs: new Map(),
  };
  return { ...base, registry };
}

let rflHomeDir: string;

beforeEach(() => {
  sessionDir = mkdtempSync(join(tmpdir(), "rfl-e2e-"));
  fixtureDir = mkdtempSync(join(tmpdir(), "rfl-e2e-agents-"));
  // rfl 仪表（tier-1 T3）：state.json 现落 ~/.review-fix-loop/——HOME 重定向到
  // 临时目录，防测试写真实 home（worker_threads 在 new Worker 时拷贝主线程 env
  // 快照，stubEnv 先于 runAndWait 即可让 worker 侧 os.homedir() 读到隔离值）。
  rflHomeDir = mkdtempSync(join(tmpdir(), "rfl-e2e-home-"));
  vi.stubEnv("HOME", rflHomeDir);
  // 压缩 script-error 重试矩阵的真实指数退避（1+2+4s → 3ms；fail-fast 用例走完
  // 重试矩阵才收敛 failed，退避占单用例耗时大头）。生产默认不变，见
  // worker-message-pump RETRY_BACKOFF_BASE_ENV 测试通道。
  vi.stubEnv("TAIJI_SUBAGENT_TEST_RETRY_BACKOFF_BASE_MS", "1");
  createdStores = [];
});

afterEach(() => {
  try {
    rmSync(sessionDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    rmSync(fixtureDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    rmSync(rflHomeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  } catch {
    // 临时目录清理失败不影响测试结论
  }
  sessionDir = "";
  fixtureDir = "";
  rflHomeDir = "";
  createdStores = [];
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const RUN_TIMEOUT_MS = 60_000;
const RUN_ID = () => "rfl-e2e-" + Date.now() + "-" + Math.floor(Math.random() * 1e6);

/**
 * MF-1-1 临时 git 仓：统一 commit 块（autoCommit）的 e2e 载体。仓内 config 写死
 * user.name/email（不依赖宿主全局 git 配置——CI 环境可能缺失）。worker 未显式传
 * cwd（WorkerHost 的 new Worker 默认继承主进程 cwd）——测试主线程 process.chdir(repo)
 * 后再 runAndWait，脚本内 execFileSync("git", ...) 即作用于本仓。
 */
/**
 * 测试内全部 git 子进程统一 env：显式钉 LC_ALL=C，使 git 自身报错文案跨系统
 * locale 恒为英文（macOS LANG 未设时 git gettext 回落系统中文，空仓
 * `git rev-parse HEAD` 输出「未知的版本或路径」→ MF-1-1b 的 'unknown revision
 * 断言在中文 locale 下失真）。只钉 git 子进程输出语言，断言语义不变。
 */
const gitEnv = (): NodeJS.ProcessEnv => ({ ...process.env, LC_ALL: "C" });

function makeTmpGitRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "rfl-e2e-git-"));
  execFileSync("git", ["init", "-q"], { cwd: repo, timeout: 10_000, env: gitEnv() });
  execFileSync("git", ["config", "user.email", "rfl-e2e@test.local"], { cwd: repo, timeout: 10_000, env: gitEnv() });
  execFileSync("git", ["config", "user.name", "rfl-e2e"], { cwd: repo, timeout: 10_000, env: gitEnv() });
  return repo;
}

describe("review-fix-loop E2E（真实 worker + 场景化 mock runner）", () => {
  it("sanity: chain 经本文件基础设施可跑（helper 自检）", async () => {
    // 返回超集对象同时满足 chain 三段 schema（analyze/transform/synthesize 均被分类为 review）
    const runner = makeScenarioRunner({
      review: [() => ({ insights: "i", keyPoints: [], plan: "p", actions: [], summary: "s", recommendation: "r" })],
      aggregate: () => ({}),
      fix: () => ({}),
    });
    const deps = makeDeps(runner);
    const result = await runAndWait(wf("chain"), { task: "x" }, deps, undefined, RUN_TIMEOUT_MS);
    expect(result.reason).toBe("completed");
  });
  it(
    "E2E-1：defer 跨轮传递 + R2 prompt 对账段 + clean 终止（§7.2 1/3）",
    async () => {
      const runner = makeScenarioRunner({
        review: [
          // R1：1 must-fix + 1 suggestion
          () => ({ report_file: "/tmp/r1-reviewer.md", must_fix: 1, suggestion: 1, reconciliation: [] }),
          // R2：known-remaining 必须含 S-1（fix 阶段 deferred 写入 → 同步 knownRemaining）；
          // 对账 MF-1 已修。若 prompt 缺 S-1 → must_fix=9 使测试失败可见。
          (prompt) => {
            if (!prompt.includes("S-1")) {
              return { report_file: "/tmp/r2-reviewer.md", must_fix: 9, suggestion: 0, reconciliation: [] };
            }
            return {
              report_file: "/tmp/r2-reviewer.md", must_fix: 0, suggestion: 0,
              reconciliation: [{ prev_id: "MF-1", status: "fixed", evidence: "read confirmed" }],
            };
          },
        ],
        aggregate: () => ({
          report_file: "/tmp/agg.md", must_fix: 1, suggestion: 1,
          must_fix_ids: [{ id: "MF-1", severity: "major" }], fixes_caution: [],
        }),
        fix: () => ({
          fixed_count: 1,
          fixes: [{ issue_id: "MF-1", description: "mock fix", self_check: "grep: 1 hit; synced", affected_files: ["src/a.ts"] }],
          deferred: [{ issue_id: "S-1", severity: "minor", reason: "needs new mechanism across modules, high cost" }],
        }),
      });
      const deps = makeDeps(runner);

      const result = await runAndWait(
        wf("review-fix-loop"),
        { targetType: "file", target: "README.md", agents: agentMd("reviewer"), _runId: RUN_ID() },
        deps,
        undefined,
        RUN_TIMEOUT_MS,
      );


      expect(result.reason).toBe("completed");
      expect(result.error).toBeUndefined();
      const outcome = assertScriptOutcome(result.scriptResult);
      expect(outcome.terminated).toBe("clean");
      expect(outcome.totalFixed).toBe(1);
      expect(outcome.message).toContain("All batches clean");

      // prompt 内容断言：R1 全量深挖（Round 1）→ fix 分流段 → R2 对账段 + known-remaining
      const { prompts, kinds, reviewCalls } = runner.stats();
      const reviewPrompts = prompts.filter((_, i) => kinds[i] === "review");
      expect(reviewPrompts[0]).toContain("Round 1");
      expect(reviewPrompts[1]).toContain("RECONCILE PREVIOUS ROUND");
      expect(reviewPrompts[1]).toContain("S-1"); // 5.3-4 deferred 跨轮继承
      // m6：aggregator prompt 裁决段（5.4 ADJUDICATION）——裁决证据/降级保真/采信抽查
      const aggPrompt = prompts[kinds.indexOf("aggregate")];
      expect(aggPrompt).toContain("ADJUDICATION");
      // m6：fix prompt 全等级修复文案（must-fix + minor 都修 / minor defer 需真实阻塞理由）+ 自检要求
      const fixPrompt = prompts[kinds.indexOf("fix")];
      expect(fixPrompt).toContain("Fix scope");
      expect(fixPrompt).toContain("all severity levels");
      expect(fixPrompt).toContain("Minor (suggestion) issues are in fix scope too");
      expect(fixPrompt).toContain("concrete blocker");
      expect(fixPrompt).toContain("self_check in each fixes[] entry MUST include");
      expect(fixPrompt).toContain("grep command + hit count + sync action");
      expect(reviewCalls.length).toBe(2);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "E2E-1b：suggestions-only 轮进 fix（全等级修复语义）→ R2 全清才 clean 终止",
    async () => {
      const runner = makeScenarioRunner({
        review: [
          // R1：suggestions-only（must_fix=0 + suggestion=2）——旧语义会在 all-clean break 提前终止（漏修）；
          // 新语义必须走 aggregate → fix 修复建议级问题
          () => ({ report_file: "/tmp/r1b-sugg.md", must_fix: 0, suggestion: 2, reconciliation: [] }),
          // R2：全 0 → all-clean（must-fix 与 suggestion 双零）终止
          () => ({ report_file: "/tmp/r2b-sugg.md", must_fix: 0, suggestion: 0, reconciliation: [] }),
        ],
        aggregate: () => ({
          report_file: "/tmp/agg-sugg.md", must_fix: 0, suggestion: 2,
          must_fix_ids: [], fixes_caution: [],
        }),
        fix: () => ({
          fixed_count: 2,
          fixes: [
            { issue_id: "S-1", description: "fix suggestion 1", self_check: "grep: 1 hit; synced", affected_files: ["src/a.ts"] },
            { issue_id: "S-2", description: "fix suggestion 2", self_check: "grep: 1 hit; synced", affected_files: ["src/b.ts"] },
          ],
          deferred: [],
        }),
      });
      const deps = makeDeps(runner);

      const result = await runAndWait(
        wf("review-fix-loop"),
        { targetType: "file", target: "README.md", agents: agentMd("reviewer"), _runId: RUN_ID() },
        deps,
        undefined,
        RUN_TIMEOUT_MS,
      );

      expect(result.reason).toBe("completed");
      expect(result.error).toBeUndefined();
      const outcome = assertScriptOutcome(result.scriptResult);
      expect(outcome.terminated).toBe("clean");
      expect(outcome.totalFixed).toBe(2);

      // 关键差异：suggestions-only 轮也派 fixer（旧语义 R1 即 all-clean break，0 次 fix）
      const { kinds, reviewCalls, prompts } = runner.stats();
      expect(reviewCalls.length).toBe(2);
      expect(kinds.filter((k) => k === "fix").length).toBe(1);
      expect(kinds.filter((k) => k === "aggregate").length).toBe(1);
      // fix prompt 携带全等级修复指令
      const fixPrompt = prompts[kinds.indexOf("fix")];
      expect(fixPrompt).toContain("all severity levels");
      expect(fixPrompt).toContain("Minor (suggestion) issues are in fix scope too");
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "E2E-2：skipCleanAgents 语义（clean agent 下轮跳过）+ fixAgent 参数接受（§7.2 2/3）",
    async () => {
      const runner = makeScenarioRunner({
        review: [
          // R1 两个 agent（顺序不定）：reviewer → dirty（2）；doc-reviewer → clean（0）。
          // doc-reviewer 走 schema-only 真实形态（M3 回归）：无 write 工具 → report_file="" +
          // report_content 返回正文，由 workflow 落盘。按 prompt 内的报告路径区分 agent
          // （顺序无关：两 generator 对同一 agent 返回同一结果）。
          (prompt) => prompt.includes("doc-reviewer.md")
            ? { report_content: "# doc-reviewer report\nPass 1 完成", report_file: "", must_fix: 0, suggestion: 0, reconciliation: [] }
            : { report_file: "/tmp/r1a.md", must_fix: 2, suggestion: 0, reconciliation: [] },
          (prompt) => prompt.includes("doc-reviewer.md")
            ? { report_content: "# doc-reviewer report\nPass 1 完成", report_file: "", must_fix: 0, suggestion: 0, reconciliation: [] }
            : { report_file: "/tmp/r1b.md", must_fix: 2, suggestion: 0, reconciliation: [] },
          // R2：仅 dirty agent 被重派（clean 被 skipCleanAgents 过滤）；返回 clean → 终止。
          // 若 skip 失效，会出现第 4 次 review 调用（断言总数=3 拦截）。
          () => ({
            report_file: "/tmp/r2.md", must_fix: 0, suggestion: 0,
            reconciliation: [{ prev_id: "MF-1", status: "fixed", evidence: "read" }, { prev_id: "MF-2", status: "fixed", evidence: "read" }],
          }),
        ],
        aggregate: () => ({
          report_file: "/tmp/agg.md", must_fix: 2, suggestion: 0,
          must_fix_ids: [{ id: "MF-1", severity: "major" }, { id: "MF-2", severity: "major" }], fixes_caution: [],
        }),
        fix: () => ({
          fixed_count: 2,
          fixes: [
            { issue_id: "MF-1", description: "fix1", self_check: "grep: 1 hit", affected_files: [] },
            { issue_id: "MF-2", description: "fix2", self_check: "grep: 1 hit", affected_files: [] },
          ],
          deferred: [],
        }),
      });
      const deps = makeDeps(runner);

      const result = await runAndWait(
        wf("review-fix-loop"),
        { targetType: "file", target: "README.md", agents: agentMd("reviewer") + "," + agentMd("doc-reviewer"), fixAgent: agentMd("reviewer"), _runId: RUN_ID() },
        deps,
        undefined,
        RUN_TIMEOUT_MS,
      );

      expect(result.reason).toBe("completed");
      expect(result.error).toBeUndefined();
      const outcome = assertScriptOutcome(result.scriptResult);
      expect(outcome.terminated).toBe("clean");
      expect(outcome.totalFixed).toBe(2);

      // skipCleanAgents：R1 两 review + R2 一 review = 3；skip 失效则为 4
      const { kinds, reviewCalls, agents, prompts } = runner.stats();
      expect(reviewCalls.length).toBe(3);
      expect(kinds.filter((k) => k === "fix").length).toBe(1);
      expect(kinds.filter((k) => k === "aggregate").length).toBe(1);
      // W6：schema-only reviewer 的 report_content 已落盘（report_file 回填），聚合
      // prompt 只内嵌计数与路径清单——正文不得随 reviewResults JSON 再嵌一份
      //（同一内容双份付费，实测 ~48% 重复）；修复前 sub_reviews JSON 含 report_content
      const aggPrompt = prompts[kinds.indexOf("aggregate")];
      expect(aggPrompt).toContain('<untrusted source="sub_reviews">'); // reviewResults JSON 仍在
      expect(aggPrompt).not.toContain("Pass 1 完成"); // 正文不在（已落盘，read 指引可取）
      expect(aggPrompt).toContain("doc-reviewer.md"); // 路径清单在（READ FIRST 段数据源）
      // S4：fixAgent 派发验证——fix 调用带 agentRef 路径（<available_subagents> location 语义）
      const fixIdx = kinds.indexOf("fix");
      expect(agents[fixIdx]).toBe(agentMd("reviewer"));
      // M3 直接证据：doc-reviewer（schema-only，report_file=""）报告经 report_content
      // 落盘到 <runDir>/batch-1/round-1/doc-reviewer.md（def.report 文件名 = 路径 basename，
      // resolveAgentDefs 路径解析）。修复前 normalizeReviewResult 丢弃
      // report_content → 落盘内容为空文件，本断言失败。
      const docReportPath = join(outcome.runDir, "batch-1", "round-1", "doc-reviewer.md");
      expect(existsSync(docReportPath)).toBe(true);
      expect(readFileSync(docReportPath, "utf-8")).toContain("doc-reviewer report");
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "E2E-3：ES3 硬校验拦截（deferred critical → fix-failure）+ [UNRESOLVED] 渲染 gate（§7.2 3/3）",
    async () => {
      const runner = makeScenarioRunner({
        review: [
          () => ({ report_file: "/tmp/r1.md", must_fix: 1, suggestion: 0, reconciliation: [] }),
        ],
        aggregate: () => ({
          report_file: "/tmp/agg.md", must_fix: 1, suggestion: 0,
          must_fix_ids: [{ id: "MF-1", severity: "critical" }], fixes_caution: [],
        }),
        // 红线违反：must-fix 被 defer 且标 critical
        fix: () => ({
          fixed_count: 0,
          fixes: [],
          deferred: [{ issue_id: "MF-1", severity: "critical", reason: "cannot fix in this round" }],
        }),
      });
      const deps = makeDeps(runner);

      const result = await runAndWait(
        wf("review-fix-loop"),
        { targetType: "file", target: "README.md", agents: agentMd("reviewer"), _runId: RUN_ID() },
        deps,
        undefined,
        RUN_TIMEOUT_MS,
      );

      expect(result.reason).toBe("completed"); // 结构化终止而非抛错
      expect(result.error).toBeUndefined();
      const outcome = assertScriptOutcome(result.scriptResult);
      expect(outcome.terminated).toBe("fix-failure");
      // 渲染 gate（5.9）：非 clean 终止 message 带 [UNRESOLVED] 前缀 + 残留原因
      expect(outcome.message).toContain("[UNRESOLVED]");
      expect(outcome.message).toContain("must-fix 不得 defer");
      expect(outcome.message).toContain("MF-1");
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "E2E-4：全 fixed + 新发现（M2：reconcile 门控 reconCount + 新发现 merge 独立执行）",
    async () => {
      // M2 回归场景：R2 所有 prev ID 声明 fixed（reconSeen 空）但仍有新发现 MF-2。
      // 修复前：reconcile 分支整体跳过 → MF-1 停留 fix-attempted（永不转 fixed）、
      // MF-2（新发现 merge 在分支内）不创建 → 残留清单含 MF-1 而非 MF-2。
      // 修复后：reconCount>0 触发 reconcileIssues → MF-1 转 fixed；新发现 merge 独立
      // 于 reconcile 执行 → MF-2 创建 → 残留仅 MF-2（max-rounds 终止）。
      let aggRound = 0;
      let fixRound = 0;
      const runner = makeScenarioRunner({
        review: [
          // R1：1 must-fix
          () => ({ report_file: "/tmp/r1-reviewer.md", must_fix: 1, suggestion: 0, reconciliation: [] }),
          // R2：MF-1 声明 fixed（全 fixed → reconSeen 空）+ 1 新发现；走 R2+ 分支
          (prompt) => {
            if (!prompt.includes("RECONCILE PREVIOUS ROUND")) {
              return { report_file: "/tmp/r2-reviewer.md", must_fix: 9, suggestion: 0, reconciliation: [] };
            }
            return {
              report_file: "/tmp/r2-reviewer.md", must_fix: 1, suggestion: 0,
              reconciliation: [{ prev_id: "MF-1", status: "fixed", evidence: "read confirmed" }],
            };
          },
        ],
        aggregate: () => {
          aggRound++;
          return {
            report_file: "/tmp/agg.md", must_fix: 1, suggestion: 0,
            // R1 只含 MF-1；R2 中 MF-1 已被 reconciliation 声明 fixed，must_fix 只剩新发现 MF-2
            must_fix_ids: aggRound === 1 ? [{ id: "MF-1", severity: "major" }] : [{ id: "MF-2", severity: "major" }],
            fixes_caution: [],
          };
        },
        fix: () => {
          fixRound++;
          return {
            fixed_count: 1,
            fixes: [{
              issue_id: fixRound === 1 ? "MF-1" : "MF-2",
              description: "mock fix",
              self_check: "grep: 1 hit; synced",
              affected_files: [],
            }],
            deferred: [],
          };
        },
      });
      const deps = makeDeps(runner);

      const result = await runAndWait(
        wf("review-fix-loop"),
        { targetType: "file", target: "README.md", agents: agentMd("reviewer"), maxRounds: 2, _runId: RUN_ID() },
        deps,
        undefined,
        RUN_TIMEOUT_MS,
      );

      expect(result.reason).toBe("completed");
      expect(result.error).toBeUndefined();
      const outcome = assertScriptOutcome(result.scriptResult);
      // R2 后仍有 must-fix（MF-2 新发现）且达到 maxRounds → max-rounds 终止
      expect(outcome.terminated).toBe("max-rounds");
      expect(outcome.totalFixed).toBe(2);
      // M2 直接可观测证据：MF-1 已被 reconcile 转 fixed → 不进残留清单；MF-2 在残留中
      // （修复前：MF-1 停留 fix-attempted 会出现在残留里、MF-2 不创建 → 本断言失败）
      expect(outcome.message).toContain("MF-2");
      expect(outcome.message).not.toContain("MF-1");

      // 两轮 review 各 1 次调用（maxRounds=2 未超轮）；aggregator/fix 各 2 次
      const { reviewCalls, kinds } = runner.stats();
      expect(reviewCalls.length).toBe(2);
      expect(kinds.filter((k) => k === "aggregate").length).toBe(2);
      expect(kinds.filter((k) => k === "fix").length).toBe(2);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "E2E-5：recheckAfterFix=true → 全批重派 + clean agent 走 scoped 分支（M4 回归）",
    async () => {
      // R1：reviewer dirty + doc-reviewer clean → fix 后 R2 全批重派（强回归模式），
      // doc-reviewer（上轮 clean）走 scoped 限定分支（modifiedFiles ∪ affectedFiles）。
      // M4 修复目标：scoped 分支的 lastModifiedFiles 在批内可读（state.lastModifiedFiles
      // 即时字段）——修复前读 state.batches（批内未 push）恒空。
      const runner = makeScenarioRunner({
        review: [
          // R1 两 agent（parallel 顺序不定）：按 prompt 内报告路径区分
          (prompt) => prompt.includes("doc-reviewer.md")
            ? { report_content: "# doc-reviewer report", report_file: "", must_fix: 0, suggestion: 0, reconciliation: [] }
            : { report_file: "/tmp/r1a.md", must_fix: 2, suggestion: 0, reconciliation: [] },
          (prompt) => prompt.includes("doc-reviewer.md")
            ? { report_content: "# doc-reviewer report", report_file: "", must_fix: 0, suggestion: 0, reconciliation: [] }
            : { report_file: "/tmp/r1b.md", must_fix: 2, suggestion: 0, reconciliation: [] },
          // R2 两个调用（reviewer 全量 R2+ / doc-reviewer scoped）：全部 clean
          () => ({ report_file: "/tmp/r2a.md", must_fix: 0, suggestion: 0, reconciliation: [{ prev_id: "MF-1", status: "fixed", evidence: "read" }, { prev_id: "MF-2", status: "fixed", evidence: "read" }] }),
          () => ({ report_file: "/tmp/r2b.md", must_fix: 0, suggestion: 0, reconciliation: [] }),
        ],
        aggregate: () => ({
          report_file: "/tmp/agg.md", must_fix: 2, suggestion: 0,
          must_fix_ids: [{ id: "MF-1", severity: "major" }, { id: "MF-2", severity: "major" }], fixes_caution: [],
        }),
        fix: () => ({
          fixed_count: 2,
          fixes: [
            { issue_id: "MF-1", description: "fix1", self_check: "grep: 1 hit", affected_files: ["src/x.ts"] },
            { issue_id: "MF-2", description: "fix2", self_check: "grep: 1 hit", affected_files: [] },
          ],
          deferred: [],
        }),
      });
      const deps = makeDeps(runner);

      const result = await runAndWait(
        wf("review-fix-loop"),
        { targetType: "file", target: "README.md", agents: agentMd("reviewer") + "," + agentMd("doc-reviewer"), recheckAfterFix: true, _runId: RUN_ID() },
        deps,
        undefined,
        RUN_TIMEOUT_MS,
      );

      expect(result.reason).toBe("completed");
      expect(result.error).toBeUndefined();
      const outcome = assertScriptOutcome(result.scriptResult);
      expect(outcome.terminated).toBe("clean");
      expect(outcome.totalFixed).toBe(2);

      // R1 两 review + R2 两 review（全批重派）= 4；skipCleanAgents 被 recheckAfterFix 覆盖
      const { prompts, kinds, reviewCalls } = runner.stats();
      expect(reviewCalls.length).toBe(4);
      // scoped 分支被触发：prompt 含 "Scoped recheck"（clean agent 限定重审）
      const scopedPrompt = prompts.filter((p) => p.includes("Scoped recheck"));
      expect(scopedPrompt.length).toBe(1);
      // M4 数据通路：affectedFiles（fix 自检标注）进 scoped prompt
      expect(scopedPrompt[0]).toContain("src/x.ts");
      // scoped prompt 含 modifiedFiles 结构行（git 实测内容取决于测试环境工作区，
      // 只断言结构存在——M4 修复的是数据源可读性）
      expect(scopedPrompt[0]).toContain("Modified files:");
      // R2+ 全量分支同时被触发（reviewer）
      expect(prompts.some((p) => p.includes("RECONCILE PREVIOUS ROUND"))).toBe(true);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "E2E-6：doc-reviewer-only 批（reconciliation 恒空）→ 重新报告转 regressed → needs-redesign（F1 回归）",
    async () => {
      // F1 场景：全部 agent 为 doc-reviewer（§5.8 推荐配置），reconciliation 恒空 →
      // reconCount 恒 0。MF-1 连续 3 轮被重新报告（must_fix_ids 含 MF-1）：
      // 修复前：merge 跳过已存在 ID → fixAttempts 恒 0 → needs-redesign 不可达；
      //   newFindings 恒 0 → R3 触发 converged（streak 2）——提前终止掩盖未修复问题。
      // 修复后：merge 把 fix-attempted 转 regressed + fixAttempts+1 → R3 时
      //   fixAttempts=2 → needs-redesign 终止（在 converged 之前，顺序正确）。
      let aggRound = 0;
      let fixRound = 0;
      const runner = makeScenarioRunner({
        review: [
          // R1
          () => ({ report_file: "/tmp/r1-dr.md", must_fix: 1, suggestion: 0, reconciliation: [] }),
          // R2：MF-1 重新报告（未修复）
          () => ({ report_file: "/tmp/r2-dr.md", must_fix: 1, suggestion: 0, reconciliation: [] }),
          // R3：MF-1 再次报告（第 2 次修复失败）
          () => ({ report_file: "/tmp/r3-dr.md", must_fix: 1, suggestion: 0, reconciliation: [] }),
        ],
        aggregate: () => {
          aggRound++;
          return {
            report_file: "/tmp/agg.md", must_fix: 1, suggestion: 0,
            must_fix_ids: [{ id: "MF-1", severity: "major" }], fixes_caution: [],
          };
        },
        fix: () => {
          fixRound++;
          return {
            fixed_count: 1,
            fixes: [{ issue_id: "MF-1", description: "fix " + fixRound, self_check: "grep: 1 hit; synced", affected_files: [] }],
            deferred: [],
          };
        },
      });
      const deps = makeDeps(runner);

      const result = await runAndWait(
        wf("review-fix-loop"),
        { targetType: "file", target: "README.md", agents: agentMd("doc-reviewer"), _runId: RUN_ID() },
        deps,
        undefined,
        RUN_TIMEOUT_MS,
      );

      expect(result.reason).toBe("completed");
      expect(result.error).toBeUndefined();
      const outcome = assertScriptOutcome(result.scriptResult);
      // F1 判别：修复前此处是 converged（提前终止掩盖未修复）；修复后 needs-redesign
      expect(outcome.terminated).toBe("needs-redesign");
      expect(outcome.message).toContain("MF-1");
      expect(outcome.message).toContain("2 次修复仍未收敛");

      const { reviewCalls } = runner.stats();
      expect(reviewCalls.length).toBe(3); // R1/R2/R3 各一次，R3 终止不再续轮
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "E2E-7：fixed 条目复发 → 不收敛 → 继续修复 → needs-redesign（MF-2 回归）",
    async () => {
      // MF-2 场景（reconciliation 驱动）：R1 报 MF-1 → R2 确认 fixed + 新发现 MF-2 →
      // R3 MF-1 复发（reconciliation not-fixed）。修复前：fixed 条目复发不转换（停留
      // fixed）→ R3 newFindings=0 收敛 streak 达 2 → terminated=converged 提前终止而
      // must-fix 仍活跃；finalMessage「残留: 无 deferred」掩盖 MF-1。
      // 修复后：R3 reconcile 把 MF-1 转 regressed（fixAttempts+1）→ 收敛门槛
      // （无 open/regressed 活跃条目）拦截 → 继续 R4 → MF-1 第 2 次 regressed
      // （fixAttempts=2）→ needs-redesign 终止（在 converged 之前，顺序正确）。
      let aggRound = 0;
      let fixRound = 0;
      const runner = makeScenarioRunner({
        review: [
          // R1：MF-1 首次发现
          () => ({ report_file: "/tmp/r1.md", must_fix: 1, suggestion: 0, reconciliation: [] }),
          // R2：MF-1 确认 fixed + 新发现 MF-2
          () => ({ report_file: "/tmp/r2.md", must_fix: 1, suggestion: 0, reconciliation: [{ prev_id: "MF-1", status: "fixed", evidence: "read confirmed" }] }),
          // R3：MF-1 复发（修复前此处不转换 → converged 提前终止）+ MF-2 未修
          () => ({ report_file: "/tmp/r3.md", must_fix: 2, suggestion: 0, reconciliation: [{ prev_id: "MF-1", status: "not-fixed", evidence: "still wrong" }, { prev_id: "MF-2", status: "not-fixed", evidence: "still wrong" }] }),
          // R4：MF-1 再次复发（第 2 次 regressed → needs-redesign）；MF-2 已修（转 fixed）
          // ——MF-2 不再累计 openStreak，避免其先触达 stuckThreshold 抢先终止
          () => ({ report_file: "/tmp/r4.md", must_fix: 1, suggestion: 0, reconciliation: [{ prev_id: "MF-1", status: "not-fixed", evidence: "still wrong" }, { prev_id: "MF-2", status: "fixed", evidence: "read confirmed" }] }),
        ],
        aggregate: () => {
          aggRound++;
          if (aggRound === 1) return { report_file: "/tmp/agg.md", must_fix: 1, suggestion: 0, must_fix_ids: [{ id: "MF-1", severity: "major" }], fixes_caution: [] };
          if (aggRound === 2) return { report_file: "/tmp/agg.md", must_fix: 1, suggestion: 0, must_fix_ids: [{ id: "MF-2", severity: "major" }], fixes_caution: [] };
          if (aggRound === 3) return { report_file: "/tmp/agg.md", must_fix: 2, suggestion: 0, must_fix_ids: [{ id: "MF-1", severity: "major" }, { id: "MF-2", severity: "major" }], fixes_caution: [] };
          return { report_file: "/tmp/agg.md", must_fix: 1, suggestion: 0, must_fix_ids: [{ id: "MF-1", severity: "major" }], fixes_caution: [] };
        },
        fix: () => {
          fixRound++;
          if (fixRound === 1) {
            return { fixed_count: 1, fixes: [{ issue_id: "MF-1", description: "fix1", self_check: "grep: 1 hit; synced", affected_files: [] }], deferred: [] };
          }
          if (fixRound === 2) {
            return { fixed_count: 1, fixes: [{ issue_id: "MF-2", description: "fix2", self_check: "grep: 1 hit; synced", affected_files: [] }], deferred: [] };
          }
          if (fixRound === 3) {
            return {
              fixed_count: 2,
              fixes: [
                { issue_id: "MF-1", description: "fix3", self_check: "grep: 1 hit; synced", affected_files: [] },
                { issue_id: "MF-2", description: "fix4", self_check: "grep: 1 hit; synced", affected_files: [] },
              ],
              deferred: [],
            };
          }
          return { fixed_count: 1, fixes: [{ issue_id: "MF-1", description: "fix5", self_check: "grep: 1 hit; synced", affected_files: [] }], deferred: [] };
        },
      });
      const deps = makeDeps(runner);

      const result = await runAndWait(
        wf("review-fix-loop"),
        { targetType: "file", target: "README.md", agents: agentMd("reviewer"), maxRounds: 4, _runId: RUN_ID() },
        deps,
        undefined,
        RUN_TIMEOUT_MS,
      );

      expect(result.reason).toBe("completed");
      expect(result.error).toBeUndefined();
      const outcome = assertScriptOutcome(result.scriptResult);
      // 修复前此处是 converged（fixed 停留 + 收敛 streak 2 → 提前终止掩盖活跃 must-fix）；
      // 修复后 fixed 复发转 regressed → 收敛门槛拦截 → R4 needs-redesign
      expect(outcome.terminated).toBe("needs-redesign");
      expect(outcome.message).toContain("MF-1");
      expect(outcome.message).toContain("2 次修复仍未收敛");

      const { reviewCalls } = runner.stats();
      expect(reviewCalls.length).toBe(4); // R1/R2/R3/R4——修复前 R3 即 converged（3 次）
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "E2E-8：L2 换号改键后对账翻译用上一轮 idMap（MF-1 回归：prev 表格号 ≠ 本轮表格号）",
    async () => {
      // MF-1 场景：同一问题（同 title）跨轮换表格号——R2 报 MF-5（改键 MF-5→MF-1）、
      // R3 报 MF-9（改键 MF-9→MF-1）。R3 reviewer 的 reconciliation prev_id 抄自 R2
      // 报告（MF-5），必须经 R2 的 idMap 翻译。修复前 reconcile 误用本轮（R3）map
      // {MF-9→MF-1}：MF-5 miss → MF-1 fix-attempted 未 seen 被假转 fixed + 幽灵 MF-5
      // 新建 → R3 不终止 needs-redesign 继续 R4。修复后：MF-5 → MF-1 seen → 第 2 次
      // regressed → needs-redesign 终止于 R3。
      let aggRound = 0;
      let fixRound = 0;
      const runner = makeScenarioRunner({
        review: [
          // R1：MF-1 首次发现
          () => ({ report_file: "/tmp/r1.md", must_fix: 1, suggestion: 0, reconciliation: [] }),
          // R2：对账 prev_id = MF-1（抄自 R1 报告，无改键）。must_fix 1 避免全员 clean
          // 早退（clean 轮不聚合，改键剧本不可达）
          () => ({ report_file: "/tmp/r2.md", must_fix: 1, suggestion: 0, reconciliation: [{ prev_id: "MF-1", status: "not-fixed", evidence: "still wrong" }] }),
          // R3：对账 prev_id = MF-5（抄自 R2 报告——R2 聚合把同一问题换号为 MF-5）
          () => ({ report_file: "/tmp/r3.md", must_fix: 1, suggestion: 0, reconciliation: [{ prev_id: "MF-5", status: "not-fixed", evidence: "still wrong" }] }),
          // R4（仅修复前的错误路径会到达）
          () => ({ report_file: "/tmp/r4.md", must_fix: 0, suggestion: 0, reconciliation: [] }),
        ],
        aggregate: () => {
          aggRound++;
          if (aggRound === 1) return { report_file: "/tmp/agg.md", must_fix: 1, suggestion: 0, must_fix_ids: [{ id: "MF-1", severity: "major", title: "Null check missing in parser" }], fixes_caution: [] };
          // R2 聚合：同一问题（同 title）换表格号为 MF-5 → L2 改键 MF-5→MF-1
          if (aggRound === 2) return { report_file: "/tmp/agg.md", must_fix: 1, suggestion: 0, must_fix_ids: [{ id: "MF-5", severity: "major", title: "Null check missing in parser" }], fixes_caution: [] };
          // R3 聚合：再换号为 MF-9 → 本轮 map {MF-9→MF-1}（错误的翻译空间）
          return { report_file: "/tmp/agg.md", must_fix: 1, suggestion: 0, must_fix_ids: [{ id: "MF-9", severity: "major", title: "Null check missing in parser" }], fixes_caution: [] };
        },
        fix: () => {
          fixRound++;
          // R2 fix 申报表格号 MF-5（经 round2 fixIdMap 翻译到 MF-1）
          if (fixRound === 1) {
            return { fixed_count: 1, fixes: [{ issue_id: "MF-1", description: "fix1", self_check: "grep: 1 hit; synced", affected_files: [] }], deferred: [] };
          }
          return { fixed_count: 1, fixes: [{ issue_id: "MF-5", description: "fix2", self_check: "grep: 1 hit; synced", affected_files: [] }], deferred: [] };
        },
      });
      const deps = makeDeps(runner);

      const result = await runAndWait(
        wf("review-fix-loop"),
        { targetType: "file", target: "README.md", agents: agentMd("reviewer"), maxRounds: 4, stuckThreshold: 5, _runId: RUN_ID() },
        deps,
        undefined,
        RUN_TIMEOUT_MS,
      );

      expect(result.reason).toBe("completed");
      expect(result.error).toBeUndefined();
      const outcome = assertScriptOutcome(result.scriptResult);
      // 修复前：MF-1 在 R3 被假转 fixed（翻译 miss）→ 不终止 → R4 继续；
      // 修复后：MF-5 经 R2 map 翻译命中 MF-1 → 第 2 次 regressed → needs-redesign @ R3
      expect(outcome.terminated).toBe("needs-redesign");
      expect(outcome.message).toContain("MF-1");
      expect(outcome.message).toContain("2 次修复仍未收敛");
      const { reviewCalls } = runner.stats();
      expect(reviewCalls.length).toBe(3);

      // MF-3 连带：aggregatorSchema 对象分支必须含 title（生成/校验不丢身份锚点字段）
      const { schemas } = runner.stats();
      const aggSchema = schemas.find((s: Record<string, unknown> | undefined) => s && "must_fix_ids" in ((s as { properties?: Record<string, unknown> }).properties ?? {})) as {
        properties: { must_fix_ids: { items: { oneOf: Array<{ properties: Record<string, unknown> }> } } };
      } | undefined;
      expect(aggSchema).toBeDefined();
      const objBranch = aggSchema!.properties.must_fix_ids.items.oneOf.find((b) => "properties" in b);
      expect(objBranch!.properties.title).toBeDefined();
      expect(objBranch!.properties.title.type).toBe("string");
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "fail-fast：未知参数名（batchl 拼错）→ workflow 失败且 error 含未知参数提示（S-19）",
    async () => {
      const runner = makeScenarioRunner({
        review: [() => ({ report_file: "/tmp/r1.md", must_fix: 0, suggestion: 0, reconciliation: [] })],
        aggregate: () => ({ report_file: "/tmp/agg.md", must_fix: 0, suggestion: 0, must_fix_ids: [], fixes_caution: [] }),
        fix: () => ({ fixed_count: 0, fixes: [], deferred: [] }),
      });
      const deps = makeDeps(runner);

      const result = await runAndWait(
        wf("review-fix-loop"),
        { targetType: "file", target: "README.md", agents: agentMd("reviewer"), batchl: "fallow-scan", _runId: RUN_ID() },
        deps,
        undefined,
        RUN_TIMEOUT_MS,
      );

      // 脚本顶层白名单校验 fail() 抛错 → worker type:"error" → 重试超限 → reason=failed
      expect(result.reason).toBe("failed");
      expect(result.error).toContain("未知参数: batchl");
      // 校验发生在任何 agent 调用之前（参数校验在脚本最顶部）
      expect(runner.stats().kinds).toEqual([]);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "fail-fast：targetType 非法枚举 / target 空串 → workflow 失败且 error 含必填提示（S-19）",
    async () => {
      const deps = makeDeps(makeScenarioRunner({
        review: [() => ({ report_file: "/tmp/r1.md", must_fix: 0, suggestion: 0, reconciliation: [] })],
        aggregate: () => ({ report_file: "/tmp/agg.md", must_fix: 0, suggestion: 0, must_fix_ids: [], fixes_caution: [] }),
        fix: () => ({ fixed_count: 0, fixes: [], deferred: [] }),
      }));

      // targetType 非法枚举（m3 TC14：chokepoint 先拦 → invalid_args + ajv 文案 + info 指引）
      const r1 = await runAndWait(
        wf("review-fix-loop"),
        { targetType: "nope", target: "README.md", agents: agentMd("reviewer"), _runId: RUN_ID() },
        deps,
        undefined,
        RUN_TIMEOUT_MS,
      );
      expect(r1.reason).toBe("invalid_args");
      expect(r1.error).toContain("Invalid args for workflow 'review-fix-loop'");
      expect(r1.error).toContain("targetType");
      expect(r1.error).toContain("Read the workflow script file");

      // target 空串（m3 required 空串复查先拦 → invalid_args；脚本 !target 成不可达死代码）
      const r2 = await runAndWait(
        wf("review-fix-loop"),
        { targetType: "file", target: "   ", agents: agentMd("reviewer"), _runId: RUN_ID() },
        deps,
        undefined,
        RUN_TIMEOUT_MS,
      );
      expect(r2.reason).toBe("invalid_args");
      // schema 驱动（minLength:1 + pattern '\\S'）：chokepoint 不发明约束
      expect(r2.error).toContain("target");
      expect(r2.error).toContain("Read the workflow script file");
    },
    RUN_TIMEOUT_MS,
  );

  // ── MF-1-1：统一 commit 块（autoCommit）e2e——真实 tmp git 仓 ──────────

  it(
    "MF-1-1a: autoCommit=true 统一 commit——staged ≡ 去重后存在路径、message 格式、误报路径过滤",
    async () => {
      const repo = makeTmpGitRepo();
      // mock fixer 声称触碰的文件（真实落盘两个）；affected_files 含重复/空白/空串/误报
      mkdirSync(join(repo, "src"), { recursive: true });
      writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n", "utf-8");
      writeFileSync(join(repo, "src", "b.ts"), "export const b = 2;\n", "utf-8");
      const origCwd = process.cwd();
      process.chdir(repo);
      try {
        const runner = makeScenarioRunner({
          review: [
            () => ({ report_file: "/tmp/mf11a-r1.md", must_fix: 1, suggestion: 0, reconciliation: [] }),
            () => ({
              report_file: "/tmp/mf11a-r2.md", must_fix: 0, suggestion: 0,
              reconciliation: [{ prev_id: "MF-1", status: "fixed", evidence: "read confirmed" }],
            }),
          ],
          aggregate: () => ({
            report_file: "/tmp/mf11a-agg.md", must_fix: 1, suggestion: 0,
            must_fix_ids: [{ id: "MF-1", severity: "major" }], fixes_caution: [],
          }),
          fix: () => ({
            fixed_count: 1,
            fixes: [{
              issue_id: "MF-1", description: "mock fix", self_check: "grep: 1 hit; synced",
              // 重复 + 尾随空白 + 空串/纯空白 + 误报（磁盘不存在）——staged 收敛为两个存在文件
              affected_files: ["src/a.ts", " src/a.ts ", "", "   ", "src/b.ts", "ghost/missing.ts"],
            }],
            deferred: [],
          }),
        });
        const deps = makeDeps(runner);
        const result = await runAndWait(
          wf("review-fix-loop"),
          { targetType: "file", target: "README.md", agents: agentMd("reviewer"), autoCommit: true, _runId: RUN_ID() },
          deps, undefined, RUN_TIMEOUT_MS,
        );

        expect(result.reason).toBe("completed");
        expect(result.error).toBeUndefined();
        const outcome = assertScriptOutcome(result.scriptResult);
        expect(outcome.terminated).toBe("clean");
        expect(outcome.totalFixed).toBe(1);

        // commit message 格式（batch/round/计数插值，与 planUnifiedCommit 单测同锚）
        const subject = execFileSync("git", ["log", "-1", "--pretty=%s"], { cwd: repo, encoding: "utf-8", timeout: 10_000, env: gitEnv() }).trim();
        expect(subject).toBe("fix: review batch 1 round 1 — 1 must-fix + 0 suggestion");
        // staged 集合 ≡ 去重后存在的 affected_files（误报路径被过滤，未炸整次 git add）
        const committed = execFileSync("git", ["show", "--name-only", "--pretty=", "HEAD"], { cwd: repo, encoding: "utf-8", timeout: 10_000, env: gitEnv() })
          .split("\n").map((s) => s.trim()).filter(Boolean).sort();
        expect(committed).toEqual(["src/a.ts", "src/b.ts"]);
        // fixImpactFiles 不做存在性过滤（收集层语义：声称触碰即进 recheck 观察面）
        const st = JSON.parse(readFileSync(join(outcome.runDir!, "state.json"), "utf8")) as {
          fixImpactFiles: string[];
        };
        expect(st.fixImpactFiles).toEqual(["src/a.ts", "src/b.ts", "ghost/missing.ts"]);
      } finally {
        process.chdir(origCwd);
        rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      }
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "MF-1-1b: 统一 commit 的 git add 失败（index.lock 争用）→ fix-failure 结构化终止 + state.json 落盘",
    async () => {
      const repo = makeTmpGitRepo();
      mkdirSync(join(repo, "src"), { recursive: true });
      writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n", "utf-8");
      // 预置 index.lock：模拟并行进程持锁（统一 commit 设计注释点名的真实风险形态——
      // 计划层（planUnifiedCommit）只过滤不存在路径，锁争用仍须走 fix-failure 分类）
      writeFileSync(join(repo, ".git", "index.lock"), "", "utf-8");
      const origCwd = process.cwd();
      process.chdir(repo);
      try {
        const runner = makeScenarioRunner({
          review: [
            () => ({ report_file: "/tmp/mf11b-r1.md", must_fix: 1, suggestion: 0, reconciliation: [] }),
          ],
          aggregate: () => ({
            report_file: "/tmp/mf11b-agg.md", must_fix: 1, suggestion: 0,
            must_fix_ids: [{ id: "MF-1", severity: "major" }], fixes_caution: [],
          }),
          fix: () => ({
            fixed_count: 1,
            fixes: [{ issue_id: "MF-1", description: "mock fix", self_check: "grep: 1 hit; synced", affected_files: ["src/a.ts"] }],
            deferred: [],
          }),
        });
        const deps = makeDeps(runner);
        const result = await runAndWait(
          wf("review-fix-loop"),
          { targetType: "file", target: "README.md", agents: agentMd("reviewer"), autoCommit: true, _runId: RUN_ID() },
          deps, undefined, RUN_TIMEOUT_MS,
        );

        expect(result.reason).toBe("completed"); // 结构化终止而非抛错
        expect(result.error).toBeUndefined();
        const outcome = assertScriptOutcome(result.scriptResult);
        // git add 抛错 → terminated='fix-failure'（结构化终止语义）
        expect(outcome.terminated).toBe("fix-failure");
        expect(outcome.message).toContain("[UNRESOLVED]");
        expect(outcome.message).toContain("统一 commit 失败");
        expect(outcome.message).toContain("git status"); // 恢复动作指引
        // 终止路径 saveState 已落盘（断点恢复依据）
        expect(existsSync(join(outcome.runDir!, "state.json"))).toBe(true);
        // 无 commit 产生（add 失败在 commit 之前；空仓 HEAD 仍不存在）
        let revParseErr = "";
        try {
          execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, timeout: 10_000, env: gitEnv() });
        } catch (e) {
          revParseErr = String(e);
        }
        expect(revParseErr).toContain("unknown revision");
      } finally {
        process.chdir(origCwd);
        rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      }
    },
    RUN_TIMEOUT_MS,
  );

  // ── MF-1-12：多分组并行派发编排（非退化 k=2 形态） ─────────────────────

  it(
    "MF-1-12: groups=2 并行派发——fix 调用 2 次（组后缀 description）、per-fixer 文档 ×2 落盘、合并计数 + ES3 全 id 覆盖",
    async () => {
      let fixN = 0;
      const runner = makeScenarioRunner({
        review: [
          // R1：2 must-fix（G1/G2 各一条）
          () => ({ report_file: "/tmp/mf112-r1.md", must_fix: 2, suggestion: 0, reconciliation: [] }),
          // R2：全 clean（两组修复经对账清账）
          () => ({
            report_file: "/tmp/mf112-r2.md", must_fix: 0, suggestion: 0,
            reconciliation: [
              { prev_id: "MF-1", status: "fixed", evidence: "read confirmed" },
              { prev_id: "MF-2", status: "fixed", evidence: "read confirmed" },
            ],
          }),
        ],
        aggregate: () => ({
          report_file: "/tmp/mf112-agg.md", must_fix: 2, suggestion: 0,
          must_fix_ids: [
            { id: "MF-1", severity: "major", adjudication: "evidence", files: ["src/a.ts"] },
            { id: "MF-2", severity: "major", adjudication: "evidence", files: ["src/b.ts"] },
          ],
          // 两组文件集不相交（相交会被 reconcileGroups 防御性合并回单组）
          groups: [
            { id: "G1", issueIds: ["MF-1"], files: ["src/a.ts"] },
            { id: "G2", issueIds: ["MF-2"], files: ["src/b.ts"] },
          ],
          fixes_caution: [],
        }),
        fix: () => {
          fixN++;
          // 按调用序分流（parallel 起跑顺序不定，但两组结果集对称——合并断言不受影响）
          return fixN === 1
            ? {
              fixed_count: 1,
              fixes: [{ issue_id: "MF-1", description: "fix g1", self_check: "grep: 1 hit", affected_files: ["src/a.ts"] }],
              deferred: [],
            }
            : {
              fixed_count: 1,
              fixes: [{ issue_id: "MF-2", description: "fix g2", self_check: "grep: 1 hit", affected_files: ["src/b.ts"] }],
              deferred: [],
            };
        },
      });
      const deps = makeDeps(runner);
      const result = await runAndWait(
        wf("review-fix-loop"),
        { targetType: "file", target: "README.md", agents: agentMd("reviewer"), _runId: RUN_ID() },
        deps, undefined, RUN_TIMEOUT_MS,
      );

      expect(result.reason).toBe("completed");
      expect(result.error).toBeUndefined();
      const outcome = assertScriptOutcome(result.scriptResult);
      // ③ ES3 校验输入含全部 id：must-fix 全进合并 fixes[]（漏修 → fix-failure，到不了 clean）
      expect(outcome.terminated).toBe("clean");
      expect(outcome.totalFixed).toBe(2);

      // ① fix agent 被调用 2 次（两组各一）
      const { kinds, prompts } = runner.stats();
      const fixIdxs = kinds.map((k, i) => (k === "fix" ? i : -1)).filter((i) => i >= 0);
      expect(fixIdxs.length).toBe(2);
      const fixPrompts = fixIdxs.map((i) => prompts[i]!);
      // fix prompt header 带组标识（group G1/2 · group G2/2），两组各占其一
      const groupTags = fixPrompts.map((p) => (p.includes("group G1/2") ? "G1" : p.includes("group G2/2") ? "G2" : "?"));
      expect(groupTags.sort()).toEqual(["G1", "G2"]);

      // ② 两份 aggregate-4-fixer-{1,2}.md 落盘且各含本组 issue 行（不含他组）
      const docOf = (fp: string): string => {
        const m = fp.match(/(\S*aggregate-4-fixer-\d+\.md)/);
        if (!m) throw new Error("fix prompt missing per-fixer doc path:\n" + fp.slice(0, 300));
        return m[1]!;
      };
      const docs = fixPrompts.map(docOf);
      expect(docs).toHaveLength(2);
      expect(new Set(docs).size).toBe(2); // 两份不同文档（G1/G2 各一份）
      const docTexts = docs.map((d) => readFileSync(d, "utf-8"));
      expect(docTexts.some((t) => t.includes("MF-1") && !t.includes("MF-2"))).toBe(true);
      expect(docTexts.some((t) => t.includes("MF-2") && !t.includes("MF-1"))).toBe(true);

      // ③ 合并 fixResult：fixed_count = 两组之和、fixes 覆盖全部 id
      // ① 组后缀 description（role=fixer 的 calls name）：fix-G1 / fix-G2
      const st = JSON.parse(readFileSync(join(outcome.runDir!, "state.json"), "utf8")) as {
        fixResults: Array<{ fixed_count: number; fixes: Array<{ issue_id: string }> }>;
        calls: Array<{ role: string; name: string }>;
      };
      expect(st.fixResults).toHaveLength(1);
      expect(st.fixResults[0]!.fixed_count).toBe(2);
      expect(st.fixResults[0]!.fixes.map((f) => f.issue_id).sort()).toEqual(["MF-1", "MF-2"]);
      const fixerNames = st.calls.filter((c) => c.role === "fixer").map((c) => c.name).sort();
      expect(fixerNames).toEqual(["fix-G1", "fix-G2"]);
    },
    RUN_TIMEOUT_MS,
  );
});

describe("startup fail-fast (ADR-0003 D6)", () => {
  const emptyScenario = {
    review: [() => ({ issues: [], must_fix: [], stuck: false })],
    aggregate: () => ({ issues: [], must_fix: [], stuck: false }),
    fix: () => ({ fixed_count: 0, fixes: [], deferred: [] }),
  };

  it("TC1: batchN 不存在路径 → 启动期 fail-fast，未调 agent", async () => {
    const runner = makeScenarioRunner(emptyScenario);
    const deps = makeDeps(runner);
    const result = await runAndWait(
      wf("review-fix-loop"),
      { targetType: "file", target: "README.md", agents: "/nonexistent/missing.md", _runId: RUN_ID() },
      deps, undefined, RUN_TIMEOUT_MS,
    );
    expect(result.reason).not.toBe("completed");
    expect(String(result.error ?? "")).toContain("Agent file not found");
    expect(String(result.error ?? "")).toContain("/nonexistent/missing.md");
    // fail-fast 在 round 前：agent mock 未被调用
    expect(runner.stats().kinds.length).toBe(0);
  }, RUN_TIMEOUT_MS);

  it("TC2: fixAgent 不存在路径 → 启动期 fail-fast", async () => {
    const runner = makeScenarioRunner(emptyScenario);
    const deps = makeDeps(runner);
    const result = await runAndWait(
      wf("review-fix-loop"),
      { targetType: "file", target: "README.md", agents: agentMd("reviewer"), fixAgent: "/nonexistent/fix.md", _runId: RUN_ID() },
      deps, undefined, RUN_TIMEOUT_MS,
    );
    expect(result.reason).not.toBe("completed");
    expect(String(result.error ?? "")).toContain("Agent file not found");
    expect(String(result.error ?? "")).toContain("/nonexistent/fix.md");
    expect(runner.stats().kinds.length).toBe(0);
  }, RUN_TIMEOUT_MS);

  // ── A6: rfl 仪表 e2e（tier-1 T3+T4：存储迁移 + calls[] 采集） ──

  it(
    "A6: state.json 落 ~/.review-fix-loop/<slug>/<runId>/ 且 calls[] 十字段全集 + phaseTimings 采集（默认剧本）",
    async () => {
      // 剧本：R1 1 must-fix → fix → R2 clean（two-round clean 终止）
      const runner = makeScenarioRunner({
        review: [
          () => ({ report_file: "/tmp/a6-r1.md", must_fix: 1, suggestion: 0, reconciliation: [] }),
          () => ({
            report_file: "/tmp/a6-r2.md", must_fix: 0, suggestion: 0,
            reconciliation: [{ prev_id: "MF-1", status: "fixed", evidence: "read confirmed" }],
          }),
        ],
        aggregate: () => ({
          report_file: "/tmp/a6-agg.md", must_fix: 1, suggestion: 0,
          must_fix_ids: [{ id: "MF-1", severity: "major" }], fixes_caution: [],
        }),
        fix: () => ({
          fixed_count: 1,
          fixes: [{ issue_id: "MF-1", description: "mock fix", self_check: "grep: 1 hit", affected_files: ["src/a.ts"] }],
          deferred: [],
        }),
      });
      const deps = makeDeps(runner);
      const userRunId = RUN_ID();
      const result = await runAndWait(
        wf("review-fix-loop"),
        { targetType: "file", target: "README.md", agents: agentMd("reviewer"), _runId: userRunId },
        deps, undefined, RUN_TIMEOUT_MS,
      );
      expect(result.reason).toBe("completed");
      const outcome = assertScriptOutcome(result.scriptResult);
      expect(outcome.terminated).toBe("clean");

      // T3 存储迁移：runDir 位于 HOME（已 stub 到 rflHomeDir）下 .review-fix-loop/<slug>/<runId>
      expect(typeof outcome.runDir).toBe("string");
      expect(outcome.runDir).toContain(join(rflHomeDir, ".review-fix-loop"));
      // 引擎注入的 _runId 覆盖用户预传值（A3 语义）——state 目录名 = 引擎 runId
      expect(outcome.runDir).not.toContain(userRunId);
      expect(result.runId).toBeTruthy();
      expect(outcome.runDir!.endsWith(result.runId)).toBe(true);

      const stateFile = join(outcome.runDir!, "state.json");
      expect(existsSync(stateFile)).toBe(true);
      const st = JSON.parse(readFileSync(stateFile, "utf8")) as {
        meta: { terminated: string };
        calls: Array<Record<string, unknown>>;
        batches: Array<{ rounds: Array<{ round: number; phaseTimings: Record<string, unknown> }> }>;
      };

      // terminated 快照（saveState 落盘）
      expect(st.meta.terminated).toBe("clean");

      // calls[]：R1 review + R1 aggregate + R1 fix + R2 review = 4 条，十字段全集
      expect(st.calls.length).toBe(4);
      const roles = st.calls.map((c) => c.role as string);
      expect(roles.filter((r) => r === "reviewer").length).toBe(2);
      expect(roles.filter((r) => r === "aggregator").length).toBe(1);
      expect(roles.filter((r) => r === "fixer").length).toBe(1);
      for (const c of st.calls) {
        expect(typeof c.batch).toBe("number");
        expect(typeof c.round).toBe("number");
        expect(typeof c.name).toBe("string");
        expect(c.name.length).toBeGreaterThan(0);
        expect(typeof c.model).toBe("string");
        expect(typeof c.durationMs).toBe("number");
        expect(c.usage).toMatchObject({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0 });
        // A12 语义精确化：promptMode = review prompt 模式（reviewer full/scoped）；
        // 非 reviewer 角色（aggregator/fixer）该字段无意义，显式落 null
        if (c.role === "reviewer") {
          expect(c.promptMode).toBe("full");
        } else {
          expect(c.promptMode).toBeNull();
        }
        expect(typeof c.promptBytes).toBe("number");
        expect(c.promptBytes).toBeGreaterThan(0);
        expect(c.sessionId).toMatch(/^sess-e2e-\d+$/);
      }
      // sessionId 与 mock runner 调用序一一对应（0..3 各出现一次）
      const sessionIds = st.calls.map((c) => c.sessionId as string).sort();
      expect(sessionIds).toEqual(["sess-e2e-0", "sess-e2e-1", "sess-e2e-2", "sess-e2e-3"]);

      // phaseTimings：R1 三键齐全（number 对），R2 clean 轮仅 review、aggregate/fix null
      const rounds = st.batches[0].rounds;
      expect(rounds.length).toBe(2);
      const [r1, r2] = rounds;
      const pair = [expect.any(Number), expect.any(Number)];
      expect(r1.phaseTimings.review).toEqual(pair);
      expect(r1.phaseTimings.aggregate).toEqual(pair);
      expect(r1.phaseTimings.fix).toEqual(pair);
      expect(r2.phaseTimings.review).toEqual(pair);
      expect(r2.phaseTimings.aggregate).toBeNull();
      expect(r2.phaseTimings.fix).toBeNull();
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "A6: recheckAfterFix=true 剧本 → calls[] 出现 promptMode=\"scoped\"（scoped 分支采集）",
    async () => {
      // 剧本同 E2E-5：R1 reviewer dirty + doc-reviewer clean → fix → R2 全批重派，
      // doc-reviewer 走 scoped 限定分支。
      const runner = makeScenarioRunner({
        review: [
          (prompt) => prompt.includes("doc-reviewer.md")
            ? { report_content: "# doc-reviewer report", report_file: "", must_fix: 0, suggestion: 0, reconciliation: [] }
            : { report_file: "/tmp/a6s-r1a.md", must_fix: 2, suggestion: 0, reconciliation: [] },
          (prompt) => prompt.includes("doc-reviewer.md")
            ? { report_content: "# doc-reviewer report", report_file: "", must_fix: 0, suggestion: 0, reconciliation: [] }
            : { report_file: "/tmp/a6s-r1b.md", must_fix: 2, suggestion: 0, reconciliation: [] },
          () => ({
            report_file: "/tmp/a6s-r2a.md", must_fix: 0, suggestion: 0,
            reconciliation: [{ prev_id: "MF-1", status: "fixed", evidence: "read" }, { prev_id: "MF-2", status: "fixed", evidence: "read" }],
          }),
          () => ({ report_file: "/tmp/a6s-r2b.md", must_fix: 0, suggestion: 0, reconciliation: [] }),
        ],
        aggregate: () => ({
          report_file: "/tmp/a6s-agg.md", must_fix: 2, suggestion: 0,
          must_fix_ids: [{ id: "MF-1", severity: "major" }, { id: "MF-2", severity: "major" }], fixes_caution: [],
        }),
        fix: () => ({
          fixed_count: 2,
          fixes: [
            { issue_id: "MF-1", description: "fix1", self_check: "grep: 1 hit", affected_files: ["src/x.ts"] },
            { issue_id: "MF-2", description: "fix2", self_check: "grep: 1 hit", affected_files: [] },
          ],
          deferred: [],
        }),
      });
      const deps = makeDeps(runner);
      const result = await runAndWait(
        wf("review-fix-loop"),
        { targetType: "file", target: "README.md", agents: agentMd("reviewer") + "," + agentMd("doc-reviewer"), recheckAfterFix: true, _runId: RUN_ID() },
        deps, undefined, RUN_TIMEOUT_MS,
      );
      expect(result.reason).toBe("completed");
      const outcome = assertScriptOutcome(result.scriptResult);
      expect(outcome.terminated).toBe("clean");

      const st = JSON.parse(readFileSync(join(outcome.runDir!, "state.json"), "utf8")) as {
        calls: Array<Record<string, unknown>>;
      };
      // 4 review（R1 ×2 + R2 ×2）+ 1 aggregate + 1 fix
      expect(st.calls.length).toBe(6);
      const reviewCalls2 = st.calls.filter((c) => c.role === "reviewer");
      const modes = reviewCalls2.map((c) => c.promptMode as string).sort();
      // R1 两调用 full；R2 全批重派：reviewer 走 R2+ full、doc-reviewer（上轮 clean）走 scoped
      expect(modes).toEqual(["full", "full", "full", "scoped"]);
    },
    RUN_TIMEOUT_MS,
  );

  // ── B6: rfl 数据链 e2e（tier-1 M1：origin/dormant/复活/消费侧过滤/schema） ──

  it(
    "B6: issues 带 origin/guidance/evidence + dormant 落盘/复活 + 消费侧过滤 + aggregatorSchema 扩展",
    async () => {
      // 剧本（三轮到 clean）：R1 聚合 2 条目（MF-1 活跃带扩展字段 + MF-D1 降级），
      // fix 只修 MF-1（降级条目被 filterActiveIds 过滤出修复队列）；R2 聚合 3 条目
      //（N-1 files 与 fix affected_files 相交 → regression；N-2 不相交 → new；
      // MF-D1 复活重新上报）fix 修 3 条；R3 全 clean 终止。
      // aggregate/fix 按调用序分流（闭包计数，不改 runner 接口）。
      let aggN = 0;
      let fixN = 0;
      const runner = makeScenarioRunner({
        review: [
          // R1：1 must-fix（触发聚合）
          () => ({ report_file: "/tmp/b6-r1.md", must_fix: 1, suggestion: 0, reconciliation: [] }),
          // R2：3 must-fix（N-1/N-2/MF-D1 复活——聚合结构化源），对账 MF-1 fixed
          () => ({
            report_file: "/tmp/b6-r2.md", must_fix: 3, suggestion: 0,
            reconciliation: [{ prev_id: "MF-1", status: "fixed", evidence: "read confirmed" }],
          }),
          // R3：全 clean（对账 3 条 fixed）
          () => ({
            report_file: "/tmp/b6-r3.md", must_fix: 0, suggestion: 0,
            reconciliation: [
              { prev_id: "N-1", status: "fixed", evidence: "read" },
              { prev_id: "N-2", status: "fixed", evidence: "read" },
              { prev_id: "MF-D1", status: "fixed", evidence: "read" },
            ],
          }),
        ],
        aggregate: () => {
          aggN++;
          if (aggN === 1) {
            return {
              report_file: "/tmp/b6-agg1.md", must_fix: 1, suggestion: 0,
              must_fix_ids: [
                { id: "MF-1", severity: "major", adjudication: "evidence",
                  files: ["src/feature.ts"], evidence: "line 42 off-by-one", guidance: "fix boundary in parser" },
                { id: "MF-D1", severity: "major", adjudication: "downgraded", note: "claim contradicts known facts" },
              ],
              fixes_caution: [],
            };
          }
          return {
            report_file: "/tmp/b6-agg2.md", must_fix: 3, suggestion: 0,
            must_fix_ids: [
              { id: "N-1", severity: "major", adjudication: "evidence",
                files: ["src/touched.ts"], evidence: "regression found", guidance: "restore guard" },
              { id: "N-2", severity: "major", adjudication: "evidence",
                files: ["docs/guide.md"], evidence: "stale doc", guidance: "update doc" },
              { id: "MF-D1", severity: "major", adjudication: "evidence",
                files: ["src/touched.ts"], evidence: "revived with concrete repro" },
            ],
            fixes_caution: [],
          };
        },
        fix: () => {
          fixN++;
          if (fixN === 1) {
            return {
              fixed_count: 1,
              fixes: [{ issue_id: "MF-1", description: "fix1", self_check: "grep: 1 hit", affected_files: ["src/touched.ts"] }],
              deferred: [],
            };
          }
          return {
            fixed_count: 3,
            fixes: [
              { issue_id: "N-1", description: "fix n1", self_check: "grep: 1 hit", affected_files: ["src/touched.ts"] },
              { issue_id: "N-2", description: "fix n2", self_check: "grep: 1 hit", affected_files: ["docs/guide.md"] },
              { issue_id: "MF-D1", description: "fix revived", self_check: "grep: 1 hit", affected_files: [] },
            ],
            deferred: [],
          };
        },
      });
      const deps = makeDeps(runner);

      const result = await runAndWait(
        wf("review-fix-loop"),
        { targetType: "file", target: "README.md", agents: agentMd("reviewer"), _runId: RUN_ID() },
        deps, undefined, RUN_TIMEOUT_MS,
      );
      expect(result.reason).toBe("completed");
      const outcome = assertScriptOutcome(result.scriptResult);
      // 到达 clean = ES3 未拦截 = R1 fix 只修 MF-1 而聚合 must_fix=1（非降级计数）口径一致；
      // 若降级条目未过滤，mustFixIds 含 MF-D1、fix 剧本不修它 → fix-failure 终止（R3 不可达）。
      expect(outcome.terminated).toBe("clean");

      const st = JSON.parse(readFileSync(join(outcome.runDir!, "state.json"), "utf8")) as {
        issues: Record<string, { origin?: string; guidance?: string; evidence?: string; status: string }>;
        dormant: Array<{ id: string; reason: string; detail: string; round: number; revived: boolean }>;
      };

      // ① 消费侧过滤（间接+直接双证）：run 到达 clean = R1 fix 只修 MF-1 而
      // mustFixIds=filterActiveIds=[MF-1]（若降级条目未过滤，ES3 判 MF-D1 漏修 →
      // fix-failure，R3 不可达）；直接证 = dormant 有 MF-D1 落盘（见④）。
      // ⑥（旧格式回归由现有 e2e 用例守护——本用例全部新格式）
      expect(st.issues["MF-1"]).toMatchObject({
        guidance: "fix boundary in parser",
        evidence: "line 42 off-by-one",
      });
      expect(st.issues["MF-1"].origin).toBeUndefined(); // R1 条目无 origin（设计 6.1）

      // ② R2 新发现 origin：N-1 regression（files 与 fix 剧本 affected_files 相交——
      // mock fixer 不写文件，regression 经 fixImpactFiles 触发）；N-2 new
      expect(st.issues["N-1"]).toMatchObject({ origin: "regression", guidance: "restore guard" });
      expect(st.issues["N-2"]).toMatchObject({ origin: "new", evidence: "stale doc" });

      // ④ 复活闭环：MF-D1 revived=true 且回修复队列（issues 有它）
      const dormantD1 = st.dormant.find((d) => d.id === "MF-D1");
      expect(dormantD1).toBeDefined();
      expect(dormantD1!.reason).toBe("adjudication-downgraded");
      expect(dormantD1!.detail).toBe("claim contradicts known facts"); // detail=note（裁决理由优先）
      expect(dormantD1!.revived).toBe(true);
      expect(st.issues["MF-D1"]).toBeDefined(); // 复活回修复队列

      // ③ R2 review prompt 含 dormant 清单；R3 prompt 不再注入（revived=true 过滤）
      const { prompts, kinds, schemas } = runner.stats();
      const reviewPrompts = prompts.filter((_, i) => kinds[i] === "review");
      expect(reviewPrompts[1]).toContain("DORMANT ISSUES");
      expect(reviewPrompts[1]).toContain("MF-D1");
      expect(reviewPrompts[1]).toContain("adjudication-downgraded");
      expect(reviewPrompts[2]).not.toContain("DORMANT ISSUES");

      // ⑤ aggregatorSchema 扩展：条目 oneOf object 分支 properties 含五扩展字段
      const aggSchemaIdx = kinds.findIndex((k) => k === "aggregate");
      const aggSchema = schemas[aggSchemaIdx] as {
        properties?: { must_fix_ids?: { items?: { oneOf?: Array<{ properties?: Record<string, unknown> }> } }; scores?: unknown };
      };
      const objBranch = aggSchema.properties?.must_fix_ids?.items?.oneOf?.find(
        (b) => b.properties && "files" in b.properties,
      );
      expect(objBranch).toBeDefined();
      for (const field of ["files", "evidence", "guidance", "adjudication", "note"]) {
        expect(objBranch!.properties).toHaveProperty(field);
      }
      expect(aggSchema.properties).toHaveProperty("scores");
    },
    RUN_TIMEOUT_MS,
  );

  // ── C5: rfl 打分 + clean 轮回填 + aggregatorModel（tier-1 M2） ──

  it(
    "C5: scores 落盘 + regression 确定性回填 + clean 轮对账回填 + aggregatorModel 降档",
    async () => {
      // 剧本（三轮到 clean）：R1 聚合带 reviewer scores；R2 聚合带 R2 reviewer 分 +
      // R1 fix LLM 三维度分 + 1 条新 issue；R2 reconciliation 全 fixed（R1 fix
      // regression 回填 = 10）；R3 全 clean → 确定性对账（N-1 fix-attempted → fixed）
      // + R2 fix 的 regression 回填（clean 轮 entry，LLM 维度 null）。
      let aggN = 0;
      const runner = makeScenarioRunner({
        review: [
          () => ({ report_file: "/tmp/c5-r1.md", must_fix: 1, suggestion: 0, reconciliation: [] }),
          () => ({
            report_file: "/tmp/c5-r2.md", must_fix: 1, suggestion: 0,
            reconciliation: [{ prev_id: "MF-1", status: "fixed", evidence: "read confirmed" }],
          }),
          () => ({
            report_file: "/tmp/c5-r3.md", must_fix: 0, suggestion: 0,
            reconciliation: [{ prev_id: "N-1", status: "fixed", evidence: "read confirmed" }],
          }),
        ],
        aggregate: () => {
          aggN++;
          if (aggN === 1) {
            return {
              report_file: "/tmp/c5-agg1.md", must_fix: 1, suggestion: 0,
              must_fix_ids: [{ id: "MF-1", severity: "major", adjudication: "evidence", files: ["src/a.ts"], evidence: "off-by-one", guidance: "fix boundary" }],
              fixes_caution: [],
              scores: [{
                round: 1, targetKind: "reviewer", targetName: "reviewer",
                dimensions: { evidence: 9, severity: 7, actionability: 8, reconciliation: 9 },
                total: 8.2,
              }],
            };
          }
          return {
            report_file: "/tmp/c5-agg2.md", must_fix: 1, suggestion: 0,
            must_fix_ids: [{ id: "N-1", severity: "major", adjudication: "evidence", files: ["src/b.ts"], evidence: "new issue", guidance: "patch it" }],
            fixes_caution: [],
            scores: [
              { round: 2, targetKind: "reviewer", targetName: "reviewer",
                dimensions: { evidence: 8, severity: 8, actionability: 9, reconciliation: 10 }, total: 8.6 },
              { round: 1, targetKind: "fix", targetName: "fix",
                dimensions: { coverage: 8, selfCheck: 9, minimality: 7 }, total: 8 },
            ],
          };
        },
        fix: () => ({
          // R1 修 MF-1、R2 修 N-1（按调用序内容差异不影响断言——issue_id 由 reconcile 驱动）
          fixed_count: 1,
          fixes: [{ issue_id: aggN === 1 ? "MF-1" : "N-1", description: "fix", self_check: "grep: 1 hit", affected_files: ["src/c.ts"] }],
          deferred: [],
        }),
      });
      const deps = makeDeps(runner);

      const result = await runAndWait(
        wf("review-fix-loop"),
        { targetType: "file", target: "README.md", agents: agentMd("reviewer"),
          aggregatorModel: "mock-model-x", _runId: RUN_ID() },
        deps, undefined, RUN_TIMEOUT_MS,
      );
      expect(result.reason).toBe("completed");
      const outcome = assertScriptOutcome(result.scriptResult);
      expect(outcome.terminated).toBe("clean");

      const st = JSON.parse(readFileSync(join(outcome.runDir!, "state.json"), "utf8")) as {
        issues: Record<string, { status: string; history: Array<{ round: number; status: string }> }>;
        scores: Array<{ round: number; targetKind: string; targetName: string; dimensions: Record<string, number | null>; total: number | null; note?: string }>;
      };

      // ① R1 reviewer entry（4 维度 + total）与 R1 fix entry（LLM 三维度 + regression 由
      // R2 reconcile 确定性回填 = 10：R2 reconciliation 全 fixed，无 regressed）
      const r1Reviewer = st.scores.find((s) => s.targetKind === "reviewer" && s.round === 1);
      expect(r1Reviewer).toMatchObject({ targetName: "reviewer", total: 8.2 });
      expect(r1Reviewer!.dimensions).toEqual({ evidence: 9, severity: 7, actionability: 8, reconciliation: 9 });

      const r1Fix = st.scores.find((s) => s.targetKind === "fix" && s.round === 1);
      expect(r1Fix).toBeDefined();
      expect(r1Fix!.dimensions).toEqual({ coverage: 8, selfCheck: 9, minimality: 7, regression: 10 });
      expect(r1Fix!.total).toBe(8); // LLM entry 的 total 保持，regression 只补维度

      // ②③ clean 轮黑洞修复：R2 fix 的 N-1 从 fix-attempted → fixed（history 有 R3
      // fixed 记录）；R2 fix 的确定性 entry（round=2，LLM 三维度 null + regression=10 +
      // total null + note 标注）
      expect(st.issues["N-1"].status).toBe("fixed");
      expect(st.issues["N-1"].history).toContainEqual({ round: 3, status: "fixed" });
      const r2Fix = st.scores.find((s) => s.targetKind === "fix" && s.round === 2);
      expect(r2Fix).toBeDefined();
      expect(r2Fix!.dimensions).toEqual({ coverage: null, selfCheck: null, minimality: null, regression: 10 });
      expect(r2Fix!.total).toBeNull();
      expect(r2Fix!.note).toContain("clean-round deterministic backfill");

      // ④ aggregatorModel 降档：aggregate 调用 model=mock-model-x；review/fix 不受影响
      const { kinds, models } = runner.stats();
      const aggModels = kinds.map((k, i) => (k === "aggregate" ? models[i] : null)).filter((m) => m !== null);
      expect(aggModels).toEqual(["mock-model-x", "mock-model-x"]);
      const reviewModels = kinds.map((k, i) => (k === "review" ? models[i] : null)).filter((m) => m !== null);
      expect(reviewModels.every((m) => m !== "mock-model-x")).toBe(true);

      // ⑤ usage 提示载体：pi-meta parameters 的 aggregatorModel description（用户可见层）
      const wfSource = readFileSync(wf("review-fix-loop"), "utf-8");
      expect(wfSource).toContain("aggregatorModel");
      expect(wfSource).toContain("AGENTS.md");
      expect(wfSource).toContain("confirm with the owner");
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "B6: exec-review 修复回归——对账通道不绕过 dormant 分区 + 已追踪条目降级重报不翻 regressed/不落 dormant",
    async () => {
      // 剧本：R1 聚合 2 条目（MF-1 活跃 + MF-D1 降级）→ fix(MF-1)；R2 reconciliation
      // 声明 MF-D1 not-fixed（绕过尝试）+ MF-1 fixed；R2 聚合把 MF-1 降级重报
      //（已追踪条目降级）+ N-1 活跃 → fix(N-1)；R3 clean。
      let aggN = 0;
      let fixN = 0;
      const runner = makeScenarioRunner({
        review: [
          () => ({ report_file: "/tmp/b6b-r1.md", must_fix: 1, suggestion: 0, reconciliation: [] }),
          () => ({
            report_file: "/tmp/b6b-r2.md", must_fix: 1, suggestion: 0,
            reconciliation: [
              { prev_id: "MF-1", status: "fixed", evidence: "read confirmed" },
              { prev_id: "MF-D1", status: "not-fixed", evidence: "still present" },
            ],
          }),
          () => ({
            report_file: "/tmp/b6b-r3.md", must_fix: 0, suggestion: 0,
            reconciliation: [{ prev_id: "N-1", status: "fixed", evidence: "read confirmed" }],
          }),
        ],
        aggregate: () => {
          aggN++;
          if (aggN === 1) {
            return {
              report_file: "/tmp/b6b-agg1.md", must_fix: 1, suggestion: 0,
              must_fix_ids: [
                { id: "MF-1", severity: "major", adjudication: "evidence", files: ["src/a.ts"] },
                { id: "MF-D1", severity: "major", adjudication: "downgraded", note: "no evidence" },
              ],
              fixes_caution: [],
            };
          }
          return {
            report_file: "/tmp/b6b-agg2.md", must_fix: 1, suggestion: 0,
            must_fix_ids: [
              { id: "MF-1", severity: "major", adjudication: "downgraded", note: "re-adjudicated down" },
              { id: "N-1", severity: "major", adjudication: "evidence", files: ["src/b.ts"] },
            ],
            fixes_caution: [],
          };
        },
        fix: () => {
          fixN++;
          return {
            fixed_count: 1,
            fixes: [{ issue_id: fixN === 1 ? "MF-1" : "N-1", description: "fix", self_check: "grep: 1 hit", affected_files: ["src/c.ts"] }],
            deferred: [],
          };
        },
      });
      const deps = makeDeps(runner);

      const result = await runAndWait(
        wf("review-fix-loop"),
        { targetType: "file", target: "README.md", agents: agentMd("reviewer"), _runId: RUN_ID() },
        deps, undefined, RUN_TIMEOUT_MS,
      );
      expect(result.reason).toBe("completed");
      const outcome = assertScriptOutcome(result.scriptResult);
      expect(outcome.terminated).toBe("clean");

      const st = JSON.parse(readFileSync(join(outcome.runDir!, "state.json"), "utf8")) as {
        issues: Record<string, { status: string; history: Array<{ round: number; status: string }> }>;
        dormant: Array<{ id: string; revived: boolean }>;
      };

      // major-1 回归：reviewer 对 dormant id（MF-D1）声明 not-fixed 不经对账通道建
      // issue（复活唯一入口 = 聚合活跃重报）——issues 无 MF-D1，dormant 记录保持
      expect(st.issues["MF-D1"]).toBeUndefined();
      const dormantD1 = st.dormant.find((d) => d.id === "MF-D1");
      expect(dormantD1).toBeDefined();
      expect(dormantD1!.revived).toBe(false);

      // major-2a 回归：已追踪条目（MF-1）被 R2 聚合降级重报 → 不翻 regressed
      //（对账 fixed 声明是权威转换：fix-attempted → fixed，history R2 fixed）
      expect(st.issues["MF-1"].status).toBe("fixed");
      expect(st.issues["MF-1"].history).toContainEqual({ round: 2, status: "fixed" });
      expect(st.issues["MF-1"].history).not.toContainEqual({ round: 2, status: "regressed" });

      // major-2b 回归：MF-1 在 issues 活跃追踪（recordDormant excludeIds）→ 不落 dormant
      expect(st.dormant.find((d) => d.id === "MF-1")).toBeUndefined();

      // N-1 正常链路 + R3 clean 轮对账回填（fix-attempted → fixed）
      expect(st.issues["N-1"].status).toBe("fixed");
      expect(st.issues["N-1"].history).toContainEqual({ round: 3, status: "fixed" });
    },
    RUN_TIMEOUT_MS,
  );

  // ── D1/D4: T9 前缀稳定化（schema 跨轮统一 + R1 空数组下游无异常） ──

  it(
    "D1/D4: 同一 run 内 R1 与 R2 review 调用 schema 逐字节相同 + 无 per-round spread + R1 空数组下游无异常",
    async () => {
      // 剧本同 B6b 骨架（R1 带 reconciliation: [] 显式输出 → fix → R2 → clean）
      let aggN = 0;
      let fixN = 0;
      const runner = makeScenarioRunner({
        review: [
          // R1：显式 reconciliation: []（required 统一后的合规输出）
          () => ({ report_file: "/tmp/d-r1.md", must_fix: 1, suggestion: 0, reconciliation: [] }),
          () => ({
            report_file: "/tmp/d-r2.md", must_fix: 0, suggestion: 0,
            reconciliation: [{ prev_id: "MF-1", status: "fixed", evidence: "read confirmed" }],
          }),
        ],
        aggregate: () => {
          aggN++;
          return {
            report_file: "/tmp/d-agg.md", must_fix: 1, suggestion: 0,
            must_fix_ids: [{ id: "MF-1", severity: "major", adjudication: "evidence", files: ["src/a.ts"] }],
            fixes_caution: [],
          };
        },
        fix: () => {
          fixN++;
          return {
            fixed_count: 1,
            fixes: [{ issue_id: "MF-1", description: "fix", self_check: "grep: 1 hit", affected_files: ["src/b.ts"] }],
            deferred: [],
          };
        },
      });
      const deps = makeDeps(runner);

      const result = await runAndWait(
        wf("review-fix-loop"),
        { targetType: "file", target: "README.md", agents: agentMd("reviewer"), _runId: RUN_ID() },
        deps, undefined, RUN_TIMEOUT_MS,
      );
      expect(result.reason).toBe("completed");
      const outcome = assertScriptOutcome(result.scriptResult);
      // R1 空数组下游无异常：run 到达 clean（reconcile 门控 reconCount===0 行为不变）
      expect(outcome.terminated).toBe("clean");

      // schema 跨轮逐字节相同（缓存前缀稳定化的 system 段前提）
      const { kinds, schemas } = runner.stats();
      const reviewSchemas = kinds
        .map((k, i) => (k === "review" ? JSON.stringify(schemas[i]) : null))
        .filter((s) => s !== null);
      expect(reviewSchemas.length).toBe(2);
      expect(reviewSchemas[0]).toBe(reviewSchemas[1]);
      const parsed = JSON.parse(reviewSchemas[0]) as { required?: string[] };
      expect(parsed.required).toEqual(["report_file", "must_fix", "suggestion", "reconciliation"]);
      expect(JSON.stringify(parsed)).not.toContain("optional for R1"); // stale description 已更新

      // 脚本内不再存在 per-round required spread
      const wfSource = readFileSync(wf("review-fix-loop"), "utf-8");
      expect(wfSource).not.toContain("...reviewerSchema, required:");
    },
    RUN_TIMEOUT_MS,
  );

  // ── 实施后对抗式审查修复（v7.1）：A1/A2/A3/A4 ──────────────────────

  it(
    "A4: 全降级轮（reviewer 报 must-fix、aggregator 全部降级）→ 不派 fixer，批推进 + 跨批 skip（W5）",
    async () => {
      // 剧本：批 1 R1 reviewer-a 报 1 must-fix，aggregator 裁决全部降级
      //（must_fix=0、唯一条目 downgraded）→ A4 守卫生效：批 1 视同 clean 终止本轮，
      // 不空转派发 fixer（修复前：mustFix===0 混过 all-clean 判定（用的是 reviewer
      // 原始计数口径）→ 照常进 Fix 阶段 → fixCount++ 白跑）；批 2 = reviewer-a +
      // reviewer-b：W5 修复后 reviewer-a 在 A4 break 前被补记 recordAgentClean
      //（裁决降级=噪声，语义等价 clean；A4 轮无 fix → fixCount 快照不变）→ 批 2
      // cross-batch skip，仅 reviewer-b 派发且直接 clean。
      const runner = makeScenarioRunner({
        review: [
          () => ({ report_file: "/tmp/a4-r1.md", must_fix: 1, suggestion: 0, reconciliation: [] }),
          () => ({ report_file: "/tmp/a4-r2.md", must_fix: 0, suggestion: 0, reconciliation: [] }),
        ],
        aggregate: () => ({
          report_file: "/tmp/a4-agg.md", must_fix: 0, suggestion: 0,
          must_fix_ids: [{ id: "MF-1", severity: "major", adjudication: "downgraded", note: "no reproducible evidence" }],
          fixes_caution: [],
        }),
        fix: () => ({ fixed_count: 0, fixes: [], deferred: [] }),
      });
      const deps = makeDeps(runner);

      const result = await runAndWait(
        wf("review-fix-loop"),
        {
          targetType: "file", target: "README.md",
          batch1: agentMd("reviewer-a"),
          batch2: agentMd("reviewer-a") + "," + agentMd("reviewer-b"), _runId: RUN_ID(),
        },
        deps, undefined, RUN_TIMEOUT_MS,
      );

      expect(result.reason).toBe("completed");
      expect(result.error).toBeUndefined();
      const outcome = assertScriptOutcome(result.scriptResult);
      expect(outcome.terminated).toBe("clean");
      // 无 fixer 调用（守卫生效）；聚合 1 次（批 1），批 2 全 clean 不聚合
      const { kinds } = runner.stats();
      expect(kinds.filter((k) => k === "fix").length).toBe(0);
      expect(kinds.filter((k) => k === "aggregate").length).toBe(1);
      // W5：review 总数 2 = 批 1 reviewer-a + 批 2 仅 reviewer-b（reviewer-a 被跨批
      // skip）；修复前 reviewer-a 未记 clean → 批 2 派 2 个 agent → 总 3，本断言拦截
      expect(kinds.filter((k) => k === "review").length).toBe(2);
      // 批推进到批 2（守卫视同 clean，不 fail-fast）+ fixCount 不虚增
      const st = JSON.parse(readFileSync(join(outcome.runDir!, "state.json"), "utf8")) as {
        batches: unknown[];
        fixCount: number;
        dormant: Array<{ id: string }>;
        agentStatus: Record<string, { lastCleanBatch: number; lastCleanFixCount: number }>;
      };
      expect(st.batches).toHaveLength(2);
      expect(st.fixCount).toBe(0);
      // W5：A4 break 前对 must_fix>0 的 reviewer 补记 clean 快照（batch=1、当时
      // fixCount=0）——shouldSkipAgent 的判定数据源
      expect(st.agentStatus["reviewer-a"]).toMatchObject({ lastCleanBatch: 1, lastCleanFixCount: 0 });
      // 批 1 的降级条目在批 1 期间落过 dormant（中间 saveState 可查）；批 2 开始时
      // dormant 批作用域重置（A2）且批 2 无降级 → 最终落盘为空
      expect(st.dormant).toEqual([]);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "F2: aggregator 缺条目级数据（schema 合法但无 must_fix_ids）不授予跨批 clean-skip——批 2 仍派该 agent",
    async () => {
      // F2 场景（第 3 轮复审 minor，弱格式 md 兜底拆除后形态）：批 1 R1 reviewer-a 报
      // 1 must-fix；aggregator 返回 schema 合法 JSON 但漏输出 must_fix_ids（降档模型
      // 漏输出的真实形态，normalizeAggregatorResult 刻意保持键缺失语义）。A4 第三条件
      // 对 undefined 恒真仍 break（保留），但 W5 补记循环若无 agg.must_fix_ids 前置，
      // 会凭「聚合自报 must_fix=0」的弱证据给 reviewer-a 记 clean → 批 2 cross-batch
      // skip →「跳一轮」被 shouldSkipAgent 放大为「跳到底」且无条目级裁决证据。修复后：
      // 批 2 reviewer-a 照常全价重扫。
      const runner = makeScenarioRunner({
        review: [
          // 批 1 R1（reviewer-a）：1 must-fix（dirty）
          () => ({ report_file: "/tmp/f2-b1r1.md", must_fix: 1, suggestion: 0, reconciliation: [] }),
          // 批 2 R1（reviewer-a / reviewer-b 顺序不定，两 generator 同结果）：全 clean
          () => ({ report_file: "/tmp/f2-b2r1a.md", must_fix: 0, suggestion: 0, reconciliation: [] }),
          () => ({ report_file: "/tmp/f2-b2r1b.md", must_fix: 0, suggestion: 0, reconciliation: [] }),
        ],
        // schema 合法（report_file/must_fix/suggestion 齐全）但无 must_fix_ids 键 →
        // A4 break 路径（mustFix=0 且无条目级裁决证据）
        aggregate: () => ({ report_file: "/tmp/f2-agg.md", must_fix: 0, suggestion: 0, fixes_caution: [] }),
        fix: () => ({ fixed_count: 0, fixes: [], deferred: [] }),
      });
      const deps = makeDeps(runner);

      const result = await runAndWait(
        wf("review-fix-loop"),
        {
          targetType: "file", target: "README.md",
          batch1: agentMd("reviewer-a"),
          batch2: agentMd("reviewer-a") + "," + agentMd("reviewer-b"), _runId: RUN_ID(),
        },
        deps, undefined, RUN_TIMEOUT_MS,
      );

      expect(result.reason).toBe("completed");
      expect(result.error).toBeUndefined();
      const outcome = assertScriptOutcome(result.scriptResult);
      expect(outcome.terminated).toBe("clean");

      const st = JSON.parse(readFileSync(join(outcome.runDir!, "state.json"), "utf8")) as {
        batches: Array<{ rounds: Array<{ round: number; mustFix: number | null }> }>;
        fixCount: number;
        agentStatus: Record<string, { lastCleanBatch?: number; lastCleanFixCount?: number }>;
      };
      expect(st.batches).toHaveLength(2);
      expect(st.fixCount).toBe(0);
      // 批 1 的轮条目 mustFix=0（聚合自报值），A4 break 路径
      expect(st.batches[0].rounds[0].mustFix).toBe(0);

      // 核心判别：批 2 仍派 reviewer-a（3 次 review = 批 1 ×1 + 批 2 ×2）。
      // 修复前 W5 凭弱证据补记 clean（batch=1、fixCount=0）→ 批 2 skip → 仅 2 次。
      const { kinds } = runner.stats();
      expect(kinds.filter((k) => k === "review").length).toBe(3);
      // aggregate 1 次（批 1 R1；批 2 全 clean 不聚合）
      expect(kinds.filter((k) => k === "aggregate").length).toBe(1);
      expect(kinds.filter((k) => k === "fix").length).toBe(0);
      // agentStatus 佐证：reviewer-a 的 clean 记录来自批 2 真实 clean 轮（=2），
      // 而非批 1 弱证据补记（修复前 =1）
      expect(st.agentStatus["reviewer-a"]).toMatchObject({ lastCleanBatch: 2, lastCleanFixCount: 0 });
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "A4/W4: R2 全降级 + 台账残留 → 守门不假 clean，追账轮 openStreak 单计至 stuck 诚实终止",
    async () => {
      // 剧本：R1 reviewer 报 2 must-fix（MF-1/MF-2 聚合均活跃）→ fix 修两个
      //（fix-attempted）；R2 reviewer 原始报 1 must-fix + 对账 MF-1 fixed /
      // MF-2 not-fixed；R2 聚合全部降级（mustFix=0、唯一条目 MF-2 downgraded）。
      // 台账守门后（2026-08-29 假 clean 修复）：A4 出口检出 MF-2 regressed 残留 →
      // 不以 clean 收工（旧行为「A4 break → clean + 台账躺着 regressed 条目」即
      // 假 clean 缺陷），跳过 fix（修复队列空）continue 追账。mock review 耗尽后
      // 重复 R2 剧本（must_fix=1 + MF-2 not-fixed）→ 每轮 reconcile 恰好一次
      //（同轮不双计，W4 语义在守门路径下保持）→ openStreak 1/2/3 → 第 3 次达
      // stuckThreshold=3 → stuck 诚实终止。
      let aggN = 0;
      const runner = makeScenarioRunner({
        review: [
          () => ({ report_file: "/tmp/w4-r1.md", must_fix: 2, suggestion: 0, reconciliation: [] }),
          () => ({
            report_file: "/tmp/w4-r2.md", must_fix: 1, suggestion: 0,
            reconciliation: [
              { prev_id: "MF-1", status: "fixed", evidence: "read confirmed" },
              { prev_id: "MF-2", status: "not-fixed", evidence: "still wrong" },
            ],
          }),
        ],
        aggregate: () => {
          aggN++;
          if (aggN === 1) {
            return {
              report_file: "/tmp/w4-agg1.md", must_fix: 2, suggestion: 0,
              must_fix_ids: [
                { id: "MF-1", severity: "major", adjudication: "evidence" },
                { id: "MF-2", severity: "major", adjudication: "evidence" },
              ],
              fixes_caution: [],
            };
          }
          return {
            report_file: "/tmp/w4-agg2.md", must_fix: 0, suggestion: 0,
            must_fix_ids: [{ id: "MF-2", severity: "major", adjudication: "downgraded", note: "weak evidence" }],
            fixes_caution: [],
          };
        },
        fix: () => ({
          fixed_count: 2,
          fixes: [
            { issue_id: "MF-1", description: "fix1", self_check: "grep: 1 hit; synced", affected_files: [] },
            { issue_id: "MF-2", description: "fix2", self_check: "grep: 1 hit; synced", affected_files: [] },
          ],
          deferred: [],
        }),
      });
      const deps = makeDeps(runner);

      const result = await runAndWait(
        wf("review-fix-loop"),
        { targetType: "file", target: "README.md", agents: agentMd("reviewer"), _runId: RUN_ID() },
        deps, undefined, RUN_TIMEOUT_MS,
      );

      expect(result.reason).toBe("completed");
      expect(result.error).toBeUndefined();
      const outcome = assertScriptOutcome(result.scriptResult);
      // 守门生效：不再以 clean 收工（假 clean 缺陷修复）——残留追账至 stuck 诚实终止
      expect(outcome.terminated).toBe("stuck");

      const st = JSON.parse(readFileSync(join(outcome.runDir!, "state.json"), "utf8")) as {
        issues: Record<string, { status: string; openStreak?: number; fixAttempts?: number; history: Array<{ round: number; status: string }> }>;
      };
      // R2 对账：MF-1 申报 fixed（带 evidence）→ fixed；MF-2 regressed（fixAttempts=1）
      expect(st.issues["MF-1"].status).toBe("fixed");
      expect(st.issues["MF-2"].status).toBe("regressed");
      expect(st.issues["MF-2"].fixAttempts).toBe(1);
      // openStreak 单计：R2/R3/R4 追账轮各 +1（3 轮 not-fixed 达阈值；同轮不双计的
      // W4 语义在守门路径下保持——每轮 reconcile 恰好一次）
      expect(st.issues["MF-2"].openStreak).toBe(3);
      expect(st.issues["MF-2"].history.filter((h) => h.round === 2 && h.status === "regressed")).toHaveLength(1);

      // 调用数：review 4（R1 + R2/R3/R4 追账）+ aggregate 4 + fix 1（追账轮修复队列空不派 fixer）
      const { kinds } = runner.stats();
      expect(kinds.filter((k) => k === "review").length).toBe(4);
      expect(kinds.filter((k) => k === "aggregate").length).toBe(4);
      expect(kinds.filter((k) => k === "fix").length).toBe(1);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "F3: review-failure 轮的 batchRounds 条目 mustFix/suggestion 为 null（未知非 0）",
    async () => {
      // 第 3 轮终审 info 锁定：失败轮（review-failure）聚合未发生，mustFix 是未知
      // 而非 0——W8 曾落 0，时间线行会被误读为 clean 轮（消费侧 rfl.mjs `?? "-"`）。
      // 剧本：reviewer 返回缺 must_fix 的违约输出（__invalidOutput 哨兵绕过契约校验）
      // → 脚本结构化终止 review-failure，断言该轮 rounds 条目 mustFix/suggestion 为 null。
      const runner = makeScenarioRunner({
        review: [() => ({ __invalidOutput: { report_file: "/tmp/f3-invalid.md", suggestion: 0 } })],
        aggregate: () => {
          throw new Error("aggregate must not run after review-failure");
        },
        fix: () => ({ fixed_count: 0, fixes: [], deferred: [] }),
      });
      const deps = makeDeps(runner);

      const result = await runAndWait(
        wf("review-fix-loop"),
        {
          targetType: "file", target: "README.md",
          batch1: agentMd("reviewer-a"), _runId: RUN_ID(),
        },
        deps, undefined, RUN_TIMEOUT_MS,
      );

      expect(result.reason).toBe("completed");
      expect(result.error).toBeUndefined();
      const outcome = assertScriptOutcome(result.scriptResult);
      expect(outcome.terminated).toBe("review-failure");

      const st = JSON.parse(readFileSync(join(outcome.runDir!, "state.json"), "utf8")) as {
        batches: Array<{ rounds: Array<{ round: number; mustFix: number | null; suggestion: number | null }> }>;
      };
      expect(st.batches).toHaveLength(1);
      expect(st.batches[0].rounds).toHaveLength(1);
      // 判别点：失败轮 mustFix/suggestion = null（未知），非 0（clean 语义）——
      // 回退为 0 时时间线 "mustFix 0" 与真实 clean 轮无法区分，本断言拦截。
      expect(st.batches[0].rounds[0].mustFix).toBeNull();
      expect(st.batches[0].rounds[0].suggestion).toBeNull();
      // 聚合/修复未发生（review-failure 在聚合前终止）
      const { kinds } = runner.stats();
      expect(kinds.filter((k) => k === "aggregate").length).toBe(0);
      expect(kinds.filter((k) => k === "fix").length).toBe(0);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "A2+A3: dormant 批作用域重置（跨批同 id 不污染对账）+ fix prompt 含 guidance 通道",
    async () => {
      // A2 剧本（跨批 id 冲突）：批 1 R1 聚合 2 条目（MF-1 活跃带 guidance / MF-3 降级
      // 落 dormant）→ fix 修 MF-1；批 1 R2 clean（对账 MF-1 fixed）→ 批 1 终止，
      // dormant=[批1的 MF-3]。批 2 R1 reviewer-b 报 1 must-fix，聚合返回活跃 MF-3
      //（aggregator id 空间每批从 MF-1 重新编号，批 2 的 MF-3 是新问题）→ fix 修它；
      // 批 2 R2 对账声明 MF-3 not-fixed（未修好）→ 聚合仍报活跃 MF-3 → fix 再修。
      // 修复前：批 1 残留 dormant MF-3 被 filterDormantFromRecon 从 reconSeen 剥离 →
      // 批 2 的 MF-3 fix-attempted 被误反转 fixed → converged 提前终止（掩盖未修复）；
      // 修复后：dormant 批作用域重置 → reconcile 正常转 regressed → 继续 fix → max-rounds。
      let aggN = 0;
      let fixN = 0;
      const runner = makeScenarioRunner({
        review: [
          // 批 1 R1（reviewer-a）：2 must-fix
          () => ({ report_file: "/tmp/a2-b1r1.md", must_fix: 2, suggestion: 0, reconciliation: [] }),
          // 批 1 R2（reviewer-a）：clean + 对账 MF-1 fixed → all-clean 终止批 1
          () => ({
            report_file: "/tmp/a2-b1r2.md", must_fix: 0, suggestion: 0,
            reconciliation: [{ prev_id: "MF-1", status: "fixed", evidence: "read confirmed" }],
          }),
          // 批 2 R1（reviewer-b）：1 must-fix（批 2 的 MF-3）
          () => ({ report_file: "/tmp/a2-b2r1.md", must_fix: 1, suggestion: 0, reconciliation: [] }),
          // 批 2 R2（reviewer-b）：MF-3 not-fixed（未修好）
          () => ({
            report_file: "/tmp/a2-b2r2.md", must_fix: 1, suggestion: 0,
            reconciliation: [{ prev_id: "MF-3", status: "not-fixed", evidence: "still wrong" }],
          }),
        ],
        aggregate: () => {
          aggN++;
          if (aggN === 1) {
            return {
              report_file: "/tmp/a2-agg1.md", must_fix: 1, suggestion: 0,
              must_fix_ids: [
                { id: "MF-1", severity: "major", adjudication: "evidence",
                  files: ["src/a.ts"], evidence: "off-by-one", guidance: "fix the boundary check in parser" },
                // W2：降级条目刻意带 guidance——per-fixer 文档渲染与修复队列
                //（filterActiveIds）同口径，降级条目的 guidance 不进 fixer 文档
                { id: "MF-3", severity: "major", adjudication: "downgraded", note: "weak evidence at the time", guidance: "downgraded-noise guidance" },
              ],
              fixes_caution: [],
            };
          }
          if (aggN === 2) {
            return {
              report_file: "/tmp/a2-agg2.md", must_fix: 1, suggestion: 0,
              must_fix_ids: [{ id: "MF-3", severity: "major", adjudication: "evidence",
                files: ["src/z.ts"], evidence: "new issue in batch 2", guidance: "patch the z guard" }],
              fixes_caution: [],
            };
          }
          return {
            report_file: "/tmp/a2-agg3.md", must_fix: 1, suggestion: 0,
            must_fix_ids: [{ id: "MF-3", severity: "major", adjudication: "evidence",
              files: ["src/z.ts"], evidence: "still broken" }],
            fixes_caution: [],
          };
        },
        fix: () => {
          fixN++;
          return {
            fixed_count: 1,
            fixes: [{
              issue_id: fixN === 1 ? "MF-1" : "MF-3",
              description: "fix " + fixN, self_check: "grep: 1 hit; synced", affected_files: [],
            }],
            deferred: [],
          };
        },
      });
      const deps = makeDeps(runner);

      const result = await runAndWait(
        wf("review-fix-loop"),
        {
          targetType: "file", target: "README.md", maxRounds: 2,
          batch1: agentMd("reviewer-a"), batch2: agentMd("reviewer-b"), _runId: RUN_ID(),
        },
        deps, undefined, RUN_TIMEOUT_MS,
      );

      expect(result.reason).toBe("completed");
      expect(result.error).toBeUndefined();
      const outcome = assertScriptOutcome(result.scriptResult);
      // 判别点：修复前批 2 R2 的 MF-3 被误反转 fixed → converged 提前终止；
      // 修复后 regressed → 不收敛 → R2 再修一轮 → maxRounds=2 到顶 → max-rounds。
      expect(outcome.terminated).toBe("max-rounds");

      const st = JSON.parse(readFileSync(join(outcome.runDir!, "state.json"), "utf8")) as {
        issues: Record<string, { status: string; history: Array<{ round: number; status: string }> }>;
        dormant: Array<{ id: string }>;
      };
      // 核心断言：批 2 的 MF-3 走 regressed（对账 not-fixed 生效）而非被批 1 dormant
      // 残留反转 fixed。批 1 的 MF-1 已被批 2 的 issues 批作用域重置清除（MF-1 批级
      // 生命周期，不跨批残留——与 dormant 同点重置）。
      expect(st.issues["MF-1"]).toBeUndefined();
      expect(st.issues["MF-3"].history).toContainEqual({ round: 2, status: "regressed" });
      expect(st.issues["MF-3"].history).not.toContainEqual({ round: 2, status: "fixed" });
      // dormant 批作用域：批 1 记录的 MF-3 在批 2 被重置；批 2 的 MF-3 活跃不落 dormant
      expect(st.dormant).toEqual([]);

      // fix 正常派发：批 1 R1 + 批 2 R1 + 批 2 R2（regressed 后再修）= 3 次
      const { kinds, prompts } = runner.stats();
      const fixIdxs = kinds.map((k, i) => (k === "fix" ? i : -1)).filter((i) => i >= 0);
      expect(fixIdxs.length).toBe(3);

      // A3 e2e（文件总线形态）：guidance 随 per-fixer 文档（aggregate-4-fixer-<k>.md，
      // 工作流从 must_fix_ids 数据确定性渲染）直达 fixer——prompt 只给文档路径
      const fixPrompts = fixIdxs.map((i) => prompts[i]);
      const docOf = (fp: string): string => {
        const m = fp.match(/(\S*aggregate-4-fixer-\d+\.md)/);
        if (!m) throw new Error("fix prompt missing per-fixer doc path:\n" + fp.slice(0, 300));
        return m[1]!;
      };
      expect(fixPrompts[0]).toContain("YOUR FIXER TASK DOCUMENT");
      const doc0 = docOf(fixPrompts[0]);
      const doc0Text = readFileSync(doc0, "utf-8");
      expect(doc0Text).toContain("MF-1");
      expect(doc0Text).toContain("guidance: fix the boundary check in parser");
      // W2：降级条目（MF-3 downgraded）的 guidance 不进文档——修复队列
      //（filterActiveIds）同口径渲染，不诱导修复已裁决噪声
      expect(doc0Text).not.toContain("downgraded-noise guidance");
      // R2+（批 2 的 fix）同样生效
      expect(readFileSync(docOf(fixPrompts[1]), "utf-8")).toContain("guidance: patch the z guard");
      // 无 guidance 条目的轮（agg3 无 guidance）→ 文档无 guidance 行
      expect(readFileSync(docOf(fixPrompts[2]), "utf-8")).not.toContain("guidance:");
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "A1: engine rebuild 后同 _runId 残留 state 被重置——calls/fixResults 无双记 + previousAttempts=1",
    async () => {
      // 受控脚本故障注入（设计 §8.2 S4 方法）：临时脚本副本在首次 fix 完成后写 marker
      // 文件并抛错 → engine script-error → rebuildRuntime（同 _runId / 同 RUN_ROOT 重跑，
      // 已完成调用按 callId 缓存重放）。attempt-2 读到 marker 不再抛。
      // 修复前：loadState 原样复用 attempt-1 残留 → 重放的 recordCall/fixResults/fixCount
      // 全部双记（calls=7/fixResults=2/fixCount=2）；修复后（A1）重置易变字段，
      // 仅 meta.previousAttempts=1 留痕。
      const faultDir = mkdtempSync(join(tmpdir(), "rfl-e2e-fault-"));
      try {
        const original = readFileSync(wf("review-fix-loop"), "utf-8");
        const utilsSrc = readFileSync(join(WORKFLOWS_DIR, "review-fix-loop-utils.cjs"), "utf-8");
        // 注入点：R1 fix 完成后的 log 行（此刻 state.json 已 saveState 落盘一次）
        const anchor = 'log("Fixed " + fixedCount + " issue(s). Total: " + totalFixed + ". Modified " + modifiedFiles.length + " file(s). Continuing...");';
        if (!original.includes(anchor)) {
          throw new Error("A1 e2e: fault anchor not found in review-fix-loop.js");
        }
        const faultCode = anchor + "\n"
          + "// [TEST-INJECTED FAULT] attempt-1 写 marker 后抛错触发 engine rebuild；attempt-2 读到 marker 不再抛\n"
          + "try {\n"
          + "  fs.accessSync(RUN_ROOT + \"/e2e-fault-marker\");\n"
          + "} catch (e) {\n"
          + "  if (String(e).includes(\"e2e-fault-marker\") === false && String(e).includes(\"ENOENT\") === false) throw e;\n"
          + "  fs.writeFileSync(RUN_ROOT + \"/e2e-fault-marker\", \"1\");\n"
          + "  throw new Error(\"e2e-injected fault: simulate script-error after first state write (A1)\");\n"
          + "}";
        const injected = original.replace(anchor, faultCode);
        const faultScriptPath = join(faultDir, "review-fix-loop.js");
        writeFileSync(faultScriptPath, injected, "utf-8");
        // utils 经 workerData.scriptPath dirname 定位——副本目录内放同版 utils
        writeFileSync(join(faultDir, "review-fix-loop-utils.cjs"), utilsSrc, "utf-8");

        // 剧本：R1 1 must-fix → fix（saveState 后触发注入 fault）→ rebuild 重放 R1 → R2 clean
        const runner = makeScenarioRunner({
          review: [
            () => ({ report_file: "/tmp/a1-r1.md", must_fix: 1, suggestion: 0, reconciliation: [] }),
            () => ({
              report_file: "/tmp/a1-r2.md", must_fix: 0, suggestion: 0,
              reconciliation: [{ prev_id: "MF-1", status: "fixed", evidence: "read confirmed" }],
            }),
          ],
          aggregate: () => ({
            report_file: "/tmp/a1-agg.md", must_fix: 1, suggestion: 0,
            must_fix_ids: [{ id: "MF-1", severity: "major" }], fixes_caution: [],
          }),
          fix: () => ({
            fixed_count: 1,
            fixes: [{ issue_id: "MF-1", description: "mock fix", self_check: "grep: 1 hit; synced", affected_files: [] }],
            deferred: [],
          }),
        });
        const deps = makeDeps(runner);
        const result = await runAndWait(
          faultScriptPath,
          { targetType: "file", target: "README.md", agents: agentMd("reviewer"), _runId: RUN_ID() },
          deps, undefined, RUN_TIMEOUT_MS,
        );

        expect(result.reason).toBe("completed");
        expect(result.error).toBeUndefined();
        const outcome = assertScriptOutcome(result.scriptResult);
        expect(outcome.terminated).toBe("clean");
        expect(outcome.totalFixed).toBe(1);

        const st = JSON.parse(readFileSync(join(outcome.runDir!, "state.json"), "utf8")) as {
          meta: { previousAttempts?: number };
          calls: Array<Record<string, unknown>>;
          fixResults: unknown[];
          fixCount: number;
        };
        // attempt-1 残留被识别并留痕
        expect(st.meta.previousAttempts).toBe(1);
        // calls 无双记：attempt-2 重放 R1（review/agg/fix）+ R2 review = 4
        //（修复前 = attempt-1 的 3 + attempt-2 的 4 = 7）
        expect(st.calls.length).toBe(4);
        expect(st.fixResults.length).toBe(1);
        expect(st.fixCount).toBe(1);
      } finally {
        rmSync(faultDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      }
    },
    RUN_TIMEOUT_MS * 2,
  );
});


// ── fail-fast（弱格式降级通道拆除后的唯一失败语义，mock 轨）─────────────
//
// 结构化返回是必须满足的前提：reviewer / aggregator / fixer 任一结构化返回失败 =
// 立即终止整个 workflow（结构化终判 + 恢复指引），不等全批跑完，由上游修环境。
// 覆盖：reviewer error 哨兵（报告文件在盘也不再降级采信——弱通道恢复已拆除）/
// reviewer 结果无效（无 error 的解析失败）/ fixer error 哨兵（F-1 形态与非确定性
// error 终判同语义）/ aggregator 重试失败终判（md 兜底解析已随通道拆除）。
describe("review-fix-loop fail-fast（结构化返回失败立即终判）", () => {
  /** F-1 形态 error 哨兵：前缀逐字 = 引擎 SSOT 常量 + failureKind 分类段（对齐
   *  真实引擎确定性失败形态）。 */
  const F1_ERROR = DETERMINISTIC_SCHEMA_FAILURE_PREFIX
    + " failureKind=schema_mismatch (structured-output tool absent) — mock F-1 sentinel";

  /** 从 review prompt 的 "Write report to: <roundDir>/<report>.md" 行解析 roundDir。 */
  function roundDirFromReviewPrompt(prompt: string): string {
    const m = /^Write report to: (.+)\/[^/]+\.md$/m.exec(prompt);
    if (!m) throw new Error("fail-fast e2e: report path line not found in review prompt");
    return m[1].trim();
  }

  /** state.json 读取（runDir 在 rflHomeDir 隔离树下）。 */
  const readState = (runDir: string): Record<string, unknown> =>
    JSON.parse(readFileSync(join(runDir, "state.json"), "utf8")) as Record<string, unknown>;

  interface FailFastOutcome {
    terminated: string;
    totalFixed?: number;
    message?: string;
    runDir?: string;
    remaining?: Array<{ id: string; status: string }>;
    disputed?: unknown[];
  }

  async function runFailFastCase(
    runner: ReturnType<typeof makeScenarioRunner>,
    args: Record<string, unknown> = {},
  ): Promise<FailFastOutcome> {
    const deps = makeDeps(runner);
    const result = await runAndWait(
      wf("review-fix-loop"),
      { targetType: "file", target: "README.md", agents: agentMd("reviewer"), _runId: RUN_ID(), ...args },
      deps, undefined, RUN_TIMEOUT_MS,
    );
    expect(result.reason).toBe("completed");
    expect(result.error).toBeUndefined();
    return assertScriptOutcome(result.scriptResult) as FailFastOutcome;
  }

  it(
    "W1: reviewer 结构化 error（F-1 形态 + 报告文件在盘）→ 立即 review-failure + 恢复指引，聚合未发生",
    async () => {
      const runner = makeScenarioRunner({
        review: [
          // F-1 error 哨兵 + 报告文件照常落盘（真实引擎形态：报告早于结构化提交落盘）
          // ——弱格式恢复已拆除：报告在盘也不再降级采信，直接终判
          (prompt) => {
            const roundDir = roundDirFromReviewPrompt(prompt);
            writeFileSync(join(roundDir, "reviewer.md"), "- Must-fix: 1\n- Suggestions: 0\n\n# Report\nfound one issue\n", "utf-8");
            return { __error: F1_ERROR };
          },
        ],
        aggregate: () => {
          throw new Error("aggregate must not run after review-failure");
        },
        fix: () => {
          throw new Error("fix must not run after review-failure");
        },
      });
      const outcome = await runFailFastCase(runner);

      expect(outcome.terminated).toBe("review-failure");
      // 终判 message 三要素：失败 agent 名 + error 原文 + 恢复指引（重试闭环）
      expect(outcome.message).toContain("审查 agent 调用失败 reviewer");
      expect(outcome.message).toContain(DETERMINISTIC_SCHEMA_FAILURE_PREFIX);
      expect(outcome.message).toContain("恢复动作");
      expect(outcome.message).toContain("structured-output");
      expect(outcome.message).toContain("[UNRESOLVED]");
      // fail-fast 立即收敛：R2 未派发（review 恰 1 次）、聚合/修复未发生
      const { kinds } = runner.stats();
      expect(kinds.filter((k) => k === "review").length).toBe(1);
      expect(kinds.filter((k) => k === "aggregate").length).toBe(0);
      expect(kinds.filter((k) => k === "fix").length).toBe(0);
      // 时间线如实：失败轮 mustFix/suggestion 为 null（未知非 0）
      const st = readState(outcome.runDir!);
      const rounds = (st.batches as Array<{ rounds: Array<{ mustFix: number | null; suggestion: number | null }> }>)[0]!.rounds;
      expect(rounds[0]!.mustFix).toBeNull();
      expect(rounds[0]!.suggestion).toBeNull();
      // degraded 可观测面零残留（返回值 / state.meta 均无 degradedRounds）
      expect("degradedRounds" in outcome).toBe(false);
      expect("degradedRounds" in (st.meta as Record<string, unknown>)).toBe(false);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "W2: reviewer 结果无效（无 error 的解析失败，拼接文本形态）→ 同 review-failure 终判",
    async () => {
      const runner = makeScenarioRunner({
        review: [
          // 旧引擎形态：value 为多轮拼接文本（normalizeReviewResult 必然 null）
          () => ({ __invalidOutput: "Round 1 turn output concatenated as plain text without schema envelope" }),
        ],
        aggregate: () => {
          throw new Error("aggregate must not run after review-failure");
        },
        fix: () => {
          throw new Error("fix must not run after review-failure");
        },
      });
      const outcome = await runFailFastCase(runner);

      expect(outcome.terminated).toBe("review-failure");
      expect(outcome.message).toContain("审查 agent 结果无效");
      expect(outcome.message).toContain("concatenated as plain text"); // raw dump 便于定位
      expect(outcome.message).toContain("恢复动作");
      const { kinds } = runner.stats();
      expect(kinds.filter((k) => k === "review").length).toBe(1);
      expect(kinds.filter((k) => k === "aggregate").length).toBe(0);
      expect(kinds.filter((k) => k === "fix").length).toBe(0);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "W3: fixer 结构化 error（F-1 形态）→ 立即 fix-failure，后续轮不发生",
    async () => {
      const runner = makeScenarioRunner({
        review: [
          () => ({ report_file: "/tmp/w3-ff-r1.md", must_fix: 1, suggestion: 0, reconciliation: [] }),
          () => {
            throw new Error("R2 review must not run after fix-failure");
          },
        ],
        aggregate: () => ({
          report_file: "/tmp/w3-ff-agg.md", must_fix: 1, suggestion: 0,
          must_fix_ids: [{ id: "MF-1", severity: "major" }], fixes_caution: [],
        }),
        fix: () => ({ __error: F1_ERROR }),
      });
      const outcome = await runFailFastCase(runner);

      expect(outcome.terminated).toBe("fix-failure");
      // 终判 message：失败组名 + error 原文 + 工作区接管恢复动作
      expect(outcome.message).toContain("fix agent 调用失败");
      expect(outcome.message).toContain(DETERMINISTIC_SCHEMA_FAILURE_PREFIX);
      expect(outcome.message).toContain("恢复动作：git status");
      expect(outcome.message).toContain("[UNRESOLVED]");
      // fail-fast 立即收敛：R2 重审不发生、fix 恰 1 次
      const { kinds } = runner.stats();
      expect(kinds.filter((k) => k === "review").length).toBe(1);
      expect(kinds.filter((k) => k === "aggregate").length).toBe(1);
      expect(kinds.filter((k) => k === "fix").length).toBe(1);
      // fixCount 不虚增（结构化返回失败即终止，fix-attempted 未记账）
      const st = readState(outcome.runDir!);
      expect(st.fixCount).toBe(0);
      expect(st.fixResults).toEqual([]);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "W4: aggregator 重试失败且无 md 兜底 → aggregator-failure 终判",
    async () => {
      const runner = makeScenarioRunner({
        review: [
          () => ({ report_file: "/tmp/w4-ff-r1.md", must_fix: 1, suggestion: 0, reconciliation: [] }),
        ],
        aggregate: () => ({ __invalidOutput: { fixes_caution: [] } }), // 原调用 + 重试均违约
        fix: () => {
          throw new Error("fix must not run after aggregator-failure");
        },
      });
      const outcome = await runFailFastCase(runner);

      expect(outcome.terminated).toBe("aggregator-failure");
      expect(outcome.message).toContain("aggregator 失败");
      expect(outcome.message).toContain("[UNRESOLVED]");
      // 重试发生（aggregate 恰 2 次），fix 未发生，review 恰 1 次
      const { kinds } = runner.stats();
      expect(kinds.filter((k) => k === "review").length).toBe(1);
      expect(kinds.filter((k) => k === "aggregate").length).toBe(2);
      expect(kinds.filter((k) => k === "fix").length).toBe(0);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "W6: fixer 非确定性 error（AgentRegistry not found）→ 与确定性 error 同语义 fix-failure 终判",
    async () => {
      // fail-fast 语义强化：拆除弱通道前只有非确定性 error 终判（F-1 形态降级续跑），
      // 现在一切 error 形态都终判——断言从「分诊例外」变为「同语义覆盖」
      const runner = makeScenarioRunner({
        review: [
          () => ({ report_file: "/tmp/w6-ff-r1.md", must_fix: 1, suggestion: 0, reconciliation: [] }),
        ],
        aggregate: () => ({
          report_file: "/tmp/w6-ff-agg.md", must_fix: 1, suggestion: 0,
          must_fix_ids: [{ id: "MF-1", severity: "major" }], fixes_caution: [],
        }),
        fix: () => ({ __error: "AgentRegistry not found: no agent named 'fix' is registered", __failureKind: "unknown" }),
      });
      const outcome = await runFailFastCase(runner);

      expect(outcome.terminated).toBe("fix-failure");
      expect(outcome.message).toContain("AgentRegistry not found");
      expect(outcome.message).toContain("恢复动作：git status");
      // 无续跑：R2 review 不发生
      const { kinds } = runner.stats();
      expect(kinds.filter((k) => k === "review").length).toBe(1);
    },
    RUN_TIMEOUT_MS,
  );
});
