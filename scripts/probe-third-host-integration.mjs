#!/usr/bin/env node
// scripts/probe-third-host-integration.mjs
//
// S5 第三宿主模拟（G3 核心）+ S1 资产一致性 + S2 floor + S6 原子写统一
// —— docs/design/subagent-core-sink-design.md §4 验收场景脚本化（u-probe-verify）。
//
// 第三宿主纪律（G3 的可证伪前提）：本脚本对 subagent-core 的全部消费**仅凭 barrel
// 导出面**——import 自 dist/index.cjs（构建产物），禁止任何 core 内部深路径 import；
// 符号签名依据 dist/index.d.ts 导出类型面，不读 core 实现源码。
//
// 覆盖场景：
//   S5① 列 agents        —— discoverAgents（tmp fixture agentDir）
//   S5② run workflow      —— normalizeWorkflowRef + loadWorkflowScriptByPath
//                             （内置 chain.js，断言 @pi-meta parameters 参数解析）
//   S5③ 崩溃恢复          —— recoverCrashedRuns（kill -9 模拟：手工构造 running
//                             快照 store 文件 → loadAll → recover，含 hooks 回调）
//   S1  资产一致性        —— t-sink.md（block-scalar description + maxTurns: 2 +
//                             多行 `- item` tools）经 parseAgentProfile/discoverAgents
//                             断言；`/x/../etc/passwd.md` 经 normalizeRef /
//                             normalizeWorkflowRef 拒绝（⛔2 声明收紧）
//   S2  预算 floor        —— maxTurnsToWatchdogMs(2) >= 1_800_000（函数级真实调用）
//   S6a 原子写确定性场景  —— 半截目标文件 + 残留 tmp 各 3 组
//                             （manifest / sessions-index / workflow-state 布局形态），
//                             listStaleTmpFiles / cleanupStaleTmpFiles /
//                             parseAtomicTmpPath / writeAtomicFile 恢复与清理语义
//   S6b 原子写随机场景    —— 并发 writer 循环 writeAtomicFile，kill -9 随机打断
//                             10 次，断言 rename 窗口外目标文件零损坏
//
// 运行方式：node scripts/probe-third-host-integration.mjs
//   前置：cd packages/subagent-core && pnpm build（产出 dist/index.cjs）。
//   临时 fixture 全部落 os.tmpdir()，脚本结束自清理。
//   退出码：0 = 全部断言通过；1 = 存在失败（失败清单见末尾输出）。

import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ── barrel 导出面（第三宿主唯一消费通道） ────────────────────

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const coreRequire = createRequire(import.meta.url);
const CORE_ENTRY = join(repoRoot, "packages", "subagent-core", "dist", "index.cjs");
if (!existsSync(CORE_ENTRY)) {
  console.error(`[probe] dist/index.cjs 不存在：${CORE_ENTRY}`);
  console.error("[probe] 恢复动作：cd packages/subagent-core && pnpm build");
  process.exit(2);
}
const core = coreRequire(CORE_ENTRY);

// ── 第三宿主最小初始化（G3 契约的第一步） ─────────────────────
// core 宿主服务（dataRoot / log）是全部宿主 API 的前提——第三宿主壳的初始化
// 责任就是一次 configureCore（错误规格：core_host_not_configured 指向恢复动作）。
// log 端口把 warn/error 引到 stderr（出声，不参与断言）。
const fixtureRoot = join(tmpdir(), `sink-probe-third-host-${process.pid}-${Date.now()}`);
core.configureCore({
  dataRoot: () => fixtureRoot,
  log: (level, component, message, data) => {
    if (level === "debug") return;
    console.error(`[core:${component}] ${level}: ${message}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);
  },
});

// ── 断言 harness ─────────────────────────────────────────────

let passCount = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    passCount++;
    console.log(`  ok  ${name}`);
  } else {
    failures.push({ name, detail });
    console.log(`FAIL  ${name}${detail === undefined ? "" : `  << ${detail}`}`);
  }
}

function section(title) {
  console.log(`\n── ${title} ─────────────────────────────────────────`);
}

// ── 临时 fixture 根 ──────────────────────────────────────────

mkdirSync(fixtureRoot, { recursive: true });

function cleanupFixture() {
  try {
    rmSync(fixtureRoot, { recursive: true, force: true });
  } catch {
    // 收尾清理尽力语义：残留目录在系统 tmp 下由 OS 回收
  }
}

// ══════════════════════════════════════════════════════════════
// Part A — S5① 列 agents + S1 资产一致性（discoverAgents / parseAgentProfile /
//          normalizeRef `..` 拒绝）
// ══════════════════════════════════════════════════════════════

async function partA() {
  section("Part A · S5① discoverAgents + S1 资产一致性");

  // fixture agentDir：t-sink.md（S1 资产：block-scalar + maxTurns + 多行 - item）
  // + 第二个普通 agent（验证多条目与码点序输出）。
  const agentDir = join(fixtureRoot, "agents");
  mkdirSync(agentDir, { recursive: true });

  const T_SINK_LINES = [
    "Sink acceptance probe agent with a multi-line",
    "block scalar description. The parser must keep",
    "every line of this text intact.",
  ];
  const tSinkMd = [
    "---",
    "name: t-sink",
    "description: >",
    ...T_SINK_LINES.map((l) => `  ${l}`),
    "maxTurns: 2",
    "tools:",
    "  - read",
    "  - bash",
    "  - edit",
    "---",
    "",
    "Body of the t-sink probe agent. Third-host execution contract.",
    "",
  ].join("\n");
  writeFileSync(join(agentDir, "t-sink.md"), tSinkMd);
  writeFileSync(
    join(agentDir, "a-plain.md"),
    ["---", "name: a-plain", "description: plain single-line agent", "---", "", "Plain body.", ""].join(
      "\n",
    ),
  );

  // ── S1：parseAgentProfile 宽容解析全字段 ──
  const profile = core.parseAgentProfile(tSinkMd, join(agentDir, "t-sink.md"));
  check("S1 parseAgentProfile: name", profile.name === "t-sink", String(profile.name));
  check(
    "S1 parseAgentProfile: description block-scalar 完整（逐行存续）",
    typeof profile.description === "string" && T_SINK_LINES.every((l) => profile.description.includes(l)),
    JSON.stringify(profile.description),
  );
  check("S1 parseAgentProfile: maxTurns === 2", profile.maxTurns === 2, String(profile.maxTurns));
  check(
    "S1 parseAgentProfile: tools 多行 `- item` 列表解析",
    Array.isArray(profile.tools) && profile.tools.join(",") === "read,bash,edit",
    JSON.stringify(profile.tools),
  );
  check(
    "S1 parseAgentProfile: body 保留",
    typeof profile.body === "string" && profile.body.includes("Body of the t-sink probe agent."),
    JSON.stringify(profile.body?.slice(0, 80)),
  );
  check(
    "S1 parseAgentProfile: meta 非 null（进注入清单的前提）",
    profile.meta !== null && profile.meta !== undefined,
    String(profile.meta),
  );
  check(
    "S1 parseAgentProfile: 宽容语义（warnings 数组形态）",
    Array.isArray(profile.warnings),
    JSON.stringify(profile.warnings),
  );

  // ── S5①：discoverAgents 装配（tmp fixture agentDir 作 hostRoot） ──
  // hostRoots[].source 是封闭 9 值 ResourceSource 枚举（dist/index.d.ts 类型面）；
  // 第三宿主注入项目级根的设计通道 = "project-host"（zsw <ws>/.zcode/agents 同款）。
  const workspaceRoot = repoRoot;
  const entries = await core.discoverAgents(workspaceRoot, [{ dir: agentDir, source: "project-host" }]);
  const names = entries.map((e) => e.name);
  check(
    "S5① discoverAgents: t-sink 在列且码点序（a-plain 先于 t-sink）",
    names.includes("t-sink") && JSON.stringify(names) === JSON.stringify([...names].sort()),
    JSON.stringify(names),
  );
  const entry = entries.find((e) => e.name === "t-sink");
  check("S5① discoverAgents: t-sink path 为绝对路径", !!entry && entry.path === join(agentDir, "t-sink.md"), String(entry?.path));
  check(
    "S1 discoverAgents: description 投影完整（block-scalar 未丢字段）",
    !!entry && T_SINK_LINES.every((l) => String(entry.description).includes(l)),
    JSON.stringify(entry?.description),
  );

  // ── S1③：`/x/../etc/passwd.md` 引用拒绝（⛔2 声明收紧，agent + workflow 双面）──
  check(
    "S1③ normalizeRef('/x/../etc/passwd.md') 拒绝（无 ext）",
    core.normalizeRef("/x/../etc/passwd.md") === null,
    String(core.normalizeRef("/x/../etc/passwd.md")),
  );
  check(
    "S1③ normalizeRef('/x/../etc/passwd.md', '.md') 拒绝",
    core.normalizeRef("/x/../etc/passwd.md", ".md") === null,
    String(core.normalizeRef("/x/../etc/passwd.md", ".md")),
  );
  check(
    "S1③ normalizeRef('/x/../y.js', '.js') 拒绝（workflow 同面）",
    core.normalizeRef("/x/../y.js", ".js") === null,
    String(core.normalizeRef("/x/../y.js", ".js")),
  );
  const wfPasswd = core.normalizeWorkflowRef("/x/../etc/passwd.md");
  check(
    "S1③ normalizeWorkflowRef('/x/../etc/passwd.md') → invalid",
    wfPasswd.kind === "invalid",
    JSON.stringify(wfPasswd),
  );
  const wfDotDot = core.normalizeWorkflowRef("/x/../y.js");
  check(
    "S1③ normalizeWorkflowRef('/x/../y.js') → invalid（⛔2 样本集）",
    wfDotDot.kind === "invalid",
    JSON.stringify(wfDotDot),
  );
  // 不误伤（~/ 合法路径保持放行）
  const tildeAgent = core.normalizeRef("~/agents/x.md", ".md");
  check(
    "⛔2 不误伤: normalizeRef('~/agents/x.md', '.md') 放行",
    typeof tildeAgent === "string" && tildeAgent.length > 0,
    String(tildeAgent),
  );
  const tildeWf = core.normalizeWorkflowRef("~/workflows/a.js");
  check(
    "⛔2 不误伤: normalizeWorkflowRef('~/workflows/a.js') → path",
    tildeWf.kind === "path",
    JSON.stringify(tildeWf),
  );
}

// ══════════════════════════════════════════════════════════════
// Part B — S5② normalizeWorkflowRef + WorkflowScript / loadWorkflowScriptByPath
//          （内置 chain.js，带参数解析）
// ══════════════════════════════════════════════════════════════

async function partB() {
  section("Part B · S5② workflow 契约面（normalizeWorkflowRef + loadWorkflowScriptByPath）");

  // 内置 workflow 名经 knownNames 宿主注入（内置名不 core 硬编码——wave1 裁决）。
  const ref = core.normalizeWorkflowRef("chain", { knownNames: ["chain", "map-reduce", "parallel"] });
  check(
    "S5② normalizeWorkflowRef('chain', knownNames) → {kind:'name', name:'chain'}",
    ref.kind === "name" && ref.name === "chain",
    JSON.stringify(ref),
  );

  // 名 → 路径解析后按路径加载（第三宿主装配形态：own 清单拼 location 绝对路径）。
  const chainPath = join(repoRoot, "packages", "subagent-core", "workflows", "chain.js");
  const script = await core.loadWorkflowScriptByPath(chainPath);
  check("S5② loadWorkflowScriptByPath(chain.js) 非 undefined", !!script, "undefined");
  if (!script) return;

  check(
    "S5② WorkflowScript: name === 'chain' 且 available",
    script.name === "chain" && script.available === true,
    `name=${script.name} available=${script.available}`,
  );
  const parameters = script.meta?.parameters;
  check(
    "S5② @pi-meta parameters 解析（draft-07 契约）",
    !!parameters && parameters.type === "object" && !!parameters.properties,
    JSON.stringify(parameters)?.slice(0, 160),
  );
  const required = Array.isArray(parameters?.required) ? parameters.required : [];
  check(
    "S5② parameters.required 含 'task'（带参数解析）",
    required.includes("task"),
    JSON.stringify(required),
  );
  const lint = script.validate();
  check(
    "S5② WorkflowScript.validate() 无 error 级 finding",
    !lint.findings.some((f) => f.severity === "error"),
    JSON.stringify(lint.findings?.slice(0, 3)),
  );
  check(
    "S5② toExecutable() 返回可执行源",
    typeof script.toExecutable() === "string" && script.toExecutable().length > 0,
    String(script.toExecutable()?.length),
  );
}

// ══════════════════════════════════════════════════════════════
// Part C — S5③ recoverCrashedRuns 崩溃恢复（kill -9 模拟 + hooks 回调）
// ══════════════════════════════════════════════════════════════

async function partC() {
  section("Part C · S5③ recoverCrashedRuns（kill -9 崩溃恢复装配）");

  // kill -9 模拟：进程崩溃前 FileRunStore.save 落盘的 running 快照行残留在
  // workflow-state 目录；「重启后」新宿主仅凭 barrel 完成 loadAll → recover。
  const runsDir = join(fixtureRoot, "workflow-state");
  mkdirSync(runsDir, { recursive: true });
  const store = new core.FileRunStore(runsDir);

  const runId = "probe-crash-run-1";
  // 快照行形态依据 dist/index.d.ts RunSnapshot（v = SNAPSHOT_VERSION）。
  const crashedSnapshot = {
    v: core.SNAPSHOT_VERSION,
    runId,
    spec: {
      scriptSource: "log('probe: crashed before recovery');",
      args: { task: "probe" },
    },
    state: {
      status: "running",
      budget: { usedTokens: 0, usedCost: 0, totalCallCount: 0 },
      calls: [],
      trace: [],
      errorLogs: [],
    },
    meta: { startedAt: new Date().toISOString() },
  };
  const stateFile = store.stateFilePath(runId);
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(crashedSnapshot) + "\n");
  check("S5③ 前置: running 快照已落盘（模拟 kill -9 残留）", existsSync(stateFile), stateFile);

  // 重启后重水合：独立 store 实例 loadAll 见残留 running。
  const hydrated = await new core.FileRunStore(runsDir).loadAll();
  check(
    "S5③ loadAll 重水合: 恰恢复 1 个 running run",
    hydrated.length === 1 && hydrated[0].runId === runId && hydrated[0].state.status === "running",
    JSON.stringify(hydrated.map((r) => ({ id: r.runId, status: r.state.status }))),
  );

  // 崩溃恢复四步装配（loadAll → failed → save → evict），hooks 回调注入样例。
  const recoveredPayloads = [];
  const runs = new Map();
  await core.recoverCrashedRuns(store, runs, "probe: process killed by SIGKILL (kill -9)", {
    onRunRecovered: (payload) => recoveredPayloads.push(payload),
  });

  const recovered = runs.get(runId);
  check(
    "S5③ recoverCrashedRuns: run 进 runs Map 且转 failed 终态",
    !!recovered && recovered.state.status === "done" && recovered.state.reason === "failed",
    JSON.stringify(recovered && { status: recovered.state.status, reason: recovered.state.reason }),
  );
  check(
    "S5③ state.error 携带恢复 reason",
    !!recovered && typeof recovered.state.error === "string" && recovered.state.error.includes("SIGKILL"),
    JSON.stringify(recovered?.state?.error),
  );
  check(
    "S5③ hooks.onRunRecovered 恰被调一次，payload {id, reason:'failed'}",
    recoveredPayloads.length === 1 &&
      recoveredPayloads[0].id === runId &&
      recoveredPayloads[0].reason === "failed",
    JSON.stringify(recoveredPayloads),
  );

  // save 步生效：磁盘回读为 failed 终态（下次启动不再见 running）。
  const reread = await new core.FileRunStore(runsDir).loadAll();
  check(
    "S5③ save 步: 磁盘回读 status=done/reason=failed（终态已持久化）",
    reread.length === 1 && reread[0].state.status === "done" && reread[0].state.reason === "failed",
    JSON.stringify(reread.map((r) => ({ status: r.state.status, reason: r.state.reason }))),
  );

  // 幂等：对已恢复态再次 recover 不产生二次转换、无 hooks 回调。
  const secondPayloads = [];
  await core.recoverCrashedRuns(store, new Map(), "probe: idempotent rerun", {
    onRunRecovered: (p) => secondPayloads.push(p),
  });
  check(
    "S5③ 幂等: 已恢复态重跑 recover 零回调",
    secondPayloads.length === 0,
    JSON.stringify(secondPayloads),
  );
}

// ══════════════════════════════════════════════════════════════
// Part D — S2 预算 floor（maxTurnsToWatchdogMs）
// ══════════════════════════════════════════════════════════════

function partD() {
  section("Part D · S2 maxTurnsToWatchdogMs floor（30min）");
  const two = core.maxTurnsToWatchdogMs(2);
  check(
    "S2 maxTurnsToWatchdogMs(2) >= 1_800_000（floor 生效）",
    typeof two === "number" && two >= 1_800_000,
    String(two),
  );
  const one = core.maxTurnsToWatchdogMs(1);
  check(
    "S2 maxTurnsToWatchdogMs(1) >= 1_800_000（floor 对小值同样生效）",
    typeof one === "number" && one >= 1_800_000,
    String(one),
  );
  const ten = core.maxTurnsToWatchdogMs(10);
  check(
    "S2 maxTurnsToWatchdogMs(10) = 10 × 5min（floor 之上线性）",
    ten === 10 * 5 * 60 * 1000,
    String(ten),
  );
}

// ══════════════════════════════════════════════════════════════
// Part E — S6a 原子写确定性场景（半截目标 + 残留 tmp × 3 组布局形态）
// ══════════════════════════════════════════════════════════════

function half(content) {
  // 手工半截文件：写入截断在 JSON 中途的内容（模拟写进程死于 write 中途的
  // 「前原子写时代」产物——目标文件直接半截）。
  return content.slice(0, Math.floor(content.length / 2));
}

async function partE() {
  section("Part E · S6a 原子写确定性场景（3 组布局形态 + 零误伤）");

  const atomicRoot = join(fixtureRoot, "atomic");
  const PROBE_PID = 424242;

  // 组 1 —— manifest 布局形态：目标缺失 + 残留 tmp 完整 → 宿主恢复提升语义
  // （listStaleTmpFiles + parseAtomicTmpPath + rename 提升；core 契约声明删除级
  // 清理由 cleanupStaleTmpFiles 承担，「校验后提升」归调用方域知识）。
  const manifestDir = join(atomicRoot, "manifest");
  mkdirSync(manifestDir, { recursive: true });
  const manifestTarget = join(manifestDir, "manifest.json");
  const manifestValid = JSON.stringify({ version: 3, entries: [{ id: "a", rev: 1 }] });
  const manifestTmp = join(manifestDir, `manifest.json.tmp.${PROBE_PID}.1-deadbeef`);
  writeFileSync(manifestTmp, manifestValid); // 崩溃前 tmp 已写满、rename 未达
  const manifestStale = core.listStaleTmpFiles(manifestDir);
  check(
    "S6a 组1 listStaleTmpFiles: 恰命中 1 条残留 tmp",
    manifestStale.length === 1 && manifestStale[0].tmpPath === manifestTmp,
    JSON.stringify(manifestStale),
  );
  check(
    "S6a 组1 parseAtomicTmpPath: targetPath 还原为 manifest.json",
    manifestStale[0] !== undefined &&
      core.parseAtomicTmpPath(manifestTmp)?.targetPath === manifestTarget &&
      core.parseAtomicTmpPath(manifestTmp)?.pid === PROBE_PID,
    JSON.stringify(core.parseAtomicTmpPath(manifestTmp)),
  );
  // 宿主恢复：tmp 完整且目标缺失 → rename 提升。
  cpSync(manifestTmp, manifestTarget);
  rmSync(manifestTmp, { force: true });
  check(
    "S6a 组1 恢复提升: manifest.json 完整（JSON.parse 过）且 tmp 消失",
    JSON.parse(readFileSync(manifestTarget, "utf8")).version === 3 && !existsSync(manifestTmp),
    "",
  );

  // 组 2 —— sessions-index 布局形态：目标在 + 残留 tmp + 非约定形态 decoy →
  // cleanupStaleTmpFiles 清理语义（只删约定形态，零误伤）。
  const sessDir = join(atomicRoot, "sessions-index");
  mkdirSync(sessDir, { recursive: true });
  const sessTarget = join(sessDir, "sessions.json");
  const sessValid = JSON.stringify({ sessions: [{ id: "s1", updatedAt: 1 }] });
  writeFileSync(sessTarget, sessValid);
  const sessTmp = join(sessDir, `sessions.json.tmp.${PROBE_PID}.2-cafebabe`);
  writeFileSync(sessTmp, sessValid);
  writeFileSync(join(sessDir, "notes.txt"), "user notes — 非约定形态，禁误伤");
  writeFileSync(join(sessDir, "other.json"), '{"also":"not a tmp"}');
  writeFileSync(join(sessDir, `sessions.json.tmp`), "无 pid/seq 后缀——非约定形态");
  const sessStale = core.listStaleTmpFiles(sessDir);
  check(
    "S6a 组2 listStaleTmpFiles: 只认约定形态（decoy/无后缀 tmp 不误报）",
    sessStale.length === 1 && sessStale[0].tmpPath === sessTmp,
    JSON.stringify(sessStale),
  );
  const cleanup = core.cleanupStaleTmpFiles(sessDir);
  check(
    "S6a 组2 cleanupStaleTmpFiles: removed 恰含残留 tmp",
    cleanup.removed.length === 1 && cleanup.removed[0] === sessTmp && cleanup.kept.length === 0,
    JSON.stringify(cleanup),
  );
  check(
    "S6a 组2 零误伤: 目标与 decoy 原样",
    readFileSync(sessTarget, "utf8") === sessValid &&
      readFileSync(join(sessDir, "notes.txt"), "utf8") === "user notes — 非约定形态，禁误伤" &&
      existsSync(join(sessDir, "other.json")) &&
      existsSync(join(sessDir, "sessions.json.tmp")),
    "",
  );

  // 组 3 —— workflow-state 布局形态：目标半截 + 残留 tmp → writeAtomicFile
  // 重写恢复完整，残留 tmp 随后清理。
  const runsDir = join(atomicRoot, "workflow-state");
  mkdirSync(runsDir, { recursive: true });
  const runTarget = join(runsDir, "run-1.json");
  const runValid = JSON.stringify({ v: "wf-run-v2", runId: "run-1", state: { status: "done" } });
  writeFileSync(runTarget, half(runValid)); // 半截目标
  const runTmp = join(runsDir, `run-1.json.tmp.${PROBE_PID}.3-beeffood`);
  writeFileSync(runTmp, runValid);
  check(
    "S6a 组3 前置: 目标半截（JSON.parse 必败）",
    (() => {
      try {
        JSON.parse(readFileSync(runTarget, "utf8"));
        return false;
      } catch {
        return true;
      }
    })(),
    "",
  );
  await core.writeAtomicFile(runTarget, runValid);
  const runCleanup = core.cleanupStaleTmpFiles(runsDir);
  check(
    "S6a 组3 writeAtomicFile 重写: 目标完整（JSON.parse 过）",
    JSON.parse(readFileSync(runTarget, "utf8")).runId === "run-1",
    "",
  );
  check(
    "S6a 组3 残留 tmp 清理: removed 恰含 run-1 tmp",
    runCleanup.removed.length === 1 && runCleanup.removed[0] === runTmp,
    JSON.stringify(runCleanup),
  );

  // 幂等 + 目录不存在宽容（d.ts 声明契约）。
  check(
    "S6a 幂等: 再次 cleanup removed=0",
    core.cleanupStaleTmpFiles(sessDir).removed.length === 0 &&
      core.cleanupStaleTmpFiles(runsDir).removed.length === 0,
    "",
  );
  check(
    "S6a 宽容: listStaleTmpFiles(目录不存在) → 空数组",
    core.listStaleTmpFiles(join(atomicRoot, "no-such-dir")).length === 0,
    "",
  );
}

// ══════════════════════════════════════════════════════════════
// Part F — S6b kill -9 随机打断（并发 writer × 10 轮）
// ══════════════════════════════════════════════════════════════

function spawnWriter(coreEntry, targetPath) {
  // 并发 writer 子进程：循环 writeAtomicFile 同一目标（tmp 命名含 pid/seq/rand
  // 防撞——并发互不踩 tmp），每轮写完整 JSON。
  const writerSrc = `
const { writeAtomicFile } = require(${JSON.stringify(coreEntry)});
(async () => {
  let round = 0;
  for (;;) {
    round++;
    await writeAtomicFile(${JSON.stringify(targetPath)}, JSON.stringify({
      writer: process.pid,
      round,
      payload: "p".repeat(2048),
    }));
    await new Promise((r) => setTimeout(r, 1));
  }
})().catch((e) => { console.error(String(e)); process.exit(1); });
`;
  const writerFile = join(dirname(targetPath), `writer-${process.pid}-${Math.random().toString(36).slice(2, 8)}.cjs`);
  writeFileSync(writerFile, writerSrc);
  const child = spawn(process.execPath, [writerFile], { stdio: "ignore" });
  return { child, writerFile };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function readTargetOrNull(targetPath) {
  try {
    return JSON.parse(readFileSync(targetPath, "utf8"));
  } catch {
    return null;
  }
}

async function partF() {
  section("Part F · S6b kill -9 随机打断（并发 writer 循环 × 10 轮）");

  const k9Dir = join(fixtureRoot, "kill9");
  mkdirSync(k9Dir, { recursive: true });
  const target = join(k9Dir, "kill9-target.json");
  // 初始完整内容：保证任何时刻目标文件「存在且完整」这一不变式可判定。
  await core.writeAtomicFile(target, JSON.stringify({ writer: 0, round: 0, payload: "seed" }));

  const ROUNDS = 10;
  let intactRounds = 0;
  const roundDetails = [];

  for (let round = 1; round <= ROUNDS; round++) {
    const writers = [spawnWriter(CORE_ENTRY, target), spawnWriter(CORE_ENTRY, target)];
    await sleep(80 + Math.floor(Math.random() * 270)); // 随机打断点（80~350ms）
    for (const w of writers) {
      try {
        process.kill(w.child.pid, "SIGKILL");
      } catch {
        // 已自行退出（如 import 失败）——round 断言仍以下方文件不变式为准
      }
    }
    // kill -9 后立即判定：目标要么旧完整、要么新完整，绝不半截。
    const parsed = readTargetOrNull(target);
    const intact =
      parsed !== null &&
      Number.isInteger(parsed.round) &&
      parsed.round >= 0 &&
      typeof parsed.payload === "string" &&
      parsed.payload.length > 0;
    if (intact) intactRounds++;
    roundDetails.push(`r${round}:${intact ? "intact" : "CORRUPT"}`);
    for (const w of writers) {
      w.child.kill("SIGKILL");
      rmSync(w.writerFile, { force: true });
    }
  }

  check(
    `S6b ${ROUNDS} 轮 kill -9 后目标文件全部完整（rename 原子性）`,
    intactRounds === ROUNDS,
    roundDetails.join(" "),
  );

  // 收尾：并发 writer 的残留 tmp 由统一清理原语回收，目标不受影响。
  const finalCleanup = core.cleanupStaleTmpFiles(k9Dir);
  const finalParsed = readTargetOrNull(target);
  check(
    "S6b 收尾: 残留 tmp 清理后目标仍完整",
    finalParsed !== null && Number.isInteger(finalParsed.round),
    JSON.stringify({ removed: finalCleanup.removed.length }),
  );
}

// ── main ─────────────────────────────────────────────────────

console.log(`[probe-third-host] core entry = ${CORE_ENTRY}`);
console.log(`[probe-third-host] fixture root = ${fixtureRoot}`);

try {
  await partA();
  await partB();
  await partC();
  partD();
  await partE();
  await partF();
} finally {
  cleanupFixture();
}

console.log("\n══════════════════════════════════════════════");
if (failures.length === 0) {
  console.log(`RESULT: PASS (${passCount} assertions)`);
  process.exit(0);
} else {
  console.log(`RESULT: FAIL (${failures.length} failed / ${passCount + failures.length} total)`);
  for (const f of failures) console.log(`  - ${f.name}${f.detail ? ` << ${f.detail}` : ""}`);
  process.exit(1);
}
