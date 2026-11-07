// observability.test.mjs — 阶段观测契约测试（统一公共观测层 + workflow-observe.mjs）：
// ① pi 产物真实执行（假 bin）：公共层事件 JSONL 落盘、10 字段恒全 + skill_version 齐全、execution end 带
//    outcome 终态词、失败终态结构化返回
// ② zcode 产物 transpile 后执行：obsAppend 经 world.run 通道捕获校验（outcome 同验）
// ③ 路径穿越拒绝：ID 含 .. 形态 → 观测告警关闭、零事件、业务照常
// ④ workflow-observe.mjs CLI（zsw 安装脚本，测试用副本）：10 字段 / outcome / 路径穿越
//    exit 2 / 参数缺失 exit 2
// ⑤ dev-merge.sh 统一命令接线（workflow-observe.mjs；env 短路）
// 全部事件以 sample_type=selftest 标记，落盘进临时 HOME，测后清理。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, mkdtempSync, existsSync, writeFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { installObsScripts } from "./helpers/obs-home.mjs";
import { productObsLayerHash } from "./helpers/run-product.mjs";

const WF = join(dirname(fileURLToPath(import.meta.url)), "..");
const PRL_PI = join(WF, "pr-lifecycle.js");
const PRL_ZCODE = join(WF, "..", "skills", "pr-cr-fix", "workflows", "pr-lifecycle.dwf.ts");
const DEV_MERGE_SH = join(WF, "..", "skills", "dev-merge", "dev-merge.sh");
const DMG_PI = join(WF, "dev-merge-gates.js");
const DMG_ZCODE = join(WF, "dev-merge-gates.dwf.ts");

const FIELDS = ["execution_id", "task_id", "skill", "stage", "step", "round", "attempt", "event", "timestamp", "sample_type"];

function readEvents(home, taskId, executionId) {
  const f = join(home, ".agents", "skill-data", "workflow-observability", taskId, `${executionId}.jsonl`);
  assert.ok(existsSync(f), `事件文件应存在：${f}`);
  return readFileSync(f, "utf8").trimEnd().split("\n").map((l) => JSON.parse(l));
}

function assertEventShape(rec, taskId, executionId, skill, opts = {}) {
  const { withSkillVersion = false } = opts;
  // 字段契约 = 10 恒全 + 可选 skill_version（构建注入常量，公共层 D6）+ 可选 outcome
  const expected = [...FIELDS];
  if (rec.skill_version !== undefined) expected.push("skill_version");
  if (rec.outcome !== undefined) expected.push("outcome");
  assert.deepEqual(Object.keys(rec).sort(), expected.sort(), "事件字段必须 10 字段恒全 + 可选 skill_version/outcome");
  assert.equal(rec.execution_id, executionId);
  assert.equal(rec.task_id, taskId);
  assert.equal(rec.skill, skill);
  assert.ok(rec.event === "start" || rec.event === "end");
  assert.match(rec.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(rec.sample_type === "production" || rec.sample_type === "selftest");
  if (withSkillVersion) {
    assert.ok(typeof rec.skill_version === "string" && rec.skill_version.trim() !== "", "产物事件应带非空 skill_version（构建器注入常量——观测层拼接契约）");
  }
  if (rec.outcome !== undefined) {
    assert.equal(rec.event, "end", "outcome 只出现在 end 事件上");
    assert.ok(typeof rec.outcome === "string" && rec.outcome.trim() !== "", "outcome 须为非空终态词");
  }
}

// pi 产物的壳自带 world/spawn（真实子进程），用子进程 runner + 假 bin 执行。
// git 假脚本按 variant 提供形态：default = 全成功应答（preflight 经 gh/fallow 失败）、
// drift = status 脏区（dev-merge-gates 发起前预检 fail-fast）、basenull = rev-parse 空输出
//（pr-lifecycle baseLock setup 失败）。不执行真实 merge 或 agent。
function runPiProduct(productPath, { argsObj = {}, gitVariant = "default" } = {}) {
  const home = mkdtempSync(join(tmpdir(), "wf-obs-home-"));
  // B-1 观测层源 hash 探针经真实子进程读 $HOME 安装位：临时 HOME 装观测层副本（与产物
  // 构建输入同内容 → 现算 hash 与产物内嵌一致，守卫放行）
  installObsScripts(home);
  const fakeBin = mkdtempSync(join(tmpdir(), "wf-obs-bin-"));
  const workDir = mkdtempSync(join(tmpdir(), "wf-obs-wd-"));
  const taskId = argsObj.taskId ?? `selftest-${Date.now()}`;
  const executionId = argsObj.executionId ?? `selftest-exec-${Date.now()}`;
  try {
    const gitBody = gitVariant === "drift"
      ? [
          "#!/bin/bash",
          'if [ "$1" = "status" ]; then echo " M fake-drift.ts"; exit 0; fi',
          `if [ "$1" = "rev-parse" ] && [ "$2" = "--show-toplevel" ]; then echo "${workDir}"; exit 0; fi`,
          'if [ "$1" = "rev-parse" ]; then echo "fakebasehash0000"; exit 0; fi',
          "exit 0",
          "",
        ].join("\n")
      : gitVariant === "basenull"
        ? [
            "#!/bin/bash",
            `if [ "$1" = "rev-parse" ] && [ "$2" = "--show-toplevel" ]; then echo "${workDir}"; exit 0; fi`,
            'if [ "$1" = "rev-parse" ]; then exit 0; fi',
            "exit 0",
            "",
          ].join("\n")
        : [
            "#!/bin/bash",
            `if [ "$1" = "rev-parse" ] && [ "$2" = "--show-toplevel" ]; then echo "${workDir}"; exit 0; fi`,
            'if [ "$1" = "rev-parse" ]; then echo "fakebasehash0000"; exit 0; fi',
            "exit 0",
            "",
          ].join("\n");
    writeExecutable(fakeBin, "git", gitBody);
    writeExecutable(fakeBin, "gh", "#!/bin/bash\nexit 1\n");
    writeExecutable(fakeBin, "fallow", "#!/bin/bash\nexit 1\n");
    const runner = [
      'import { readFileSync } from "node:fs";',
      'import { createRequire } from "node:module";',
      `const code = readFileSync(${JSON.stringify(productPath)}, "utf8");`,
      "const logs = [];",
      "const sandbox = {",
      `  $ARGS: ${JSON.stringify({ taskId, executionId, sampleType: "selftest", ...argsObj })},`,
      '  $MODEL: "selftest-mock-model",',
      '  agent: async () => ({ error: "selftest-mock: agent 调用不可用" }),',
      "  log: (m) => logs.push(String(m)),",
      "  phase: () => {},",
      '  require: createRequire(import.meta.url),',
      "};",
      "for (const k of Object.keys(sandbox)) globalThis[k] = sandbox[k];",
      "let ret = null, err = null;",
      'try { ret = await eval("(async () => {\\n" + code + "\\n})()"); } catch (e) { err = String(e && e.message ? e.message : e); }',
      'console.log("@@RESULT@@" + JSON.stringify({ ret, err, logs }));',
    ].join("\n");
    const runnerPath = join(workDir, "runner.mjs");
    writeFileSync(runnerPath, runner);
    const r = spawnSync(process.execPath, [runnerPath], {
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, HOME: home, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
    });
    const outLine = (r.stdout ?? "").split("\n").find((l) => l.startsWith("@@RESULT@@"));
    assert.ok(outLine, `runner 应输出结果行（stderr: ${(r.stderr ?? "").slice(0, 400)}）`);
    return { home, taskId, executionId, ...JSON.parse(outLine.slice("@@RESULT@@".length)) };
  } finally {
    rmSync(fakeBin, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
}

function writeExecutable(dir, name, body) {
  const p = join(dir, name);
  writeFileSync(p, body);
  chmodSync(p, 0o755);
}

test("pi 产物执行：公共层事件落盘 + execution end 带 outcome + 失败终态结构化返回（pr-lifecycle）", () => {
  const { home, taskId, executionId, ret, err, logs } = runPiProduct(PRL_PI);
  try {
    assert.equal(err, null, `产物执行不应 throw（errored run）：${err}`);
    assert.equal(ret.status, "failed");
    assert.equal(ret.failedStep, "preflight");
    assert.match(ret.recovery, /重新发起/);
    const events = readEvents(home, taskId, executionId);
    // execution start + preflight start/end + execution end(outcome=failed) ≥ 4
    assert.ok(events.length >= 4, `至少 execution/preflight 的 start+end 四事件（实际 ${events.length}）`);
    for (const rec of events) assertEventShape(rec, taskId, executionId, "pr-cr-fix", { withSkillVersion: true });
    assert.equal(events[0].event, "start");
    assert.equal(events[0].step, "execution");
    assert.equal(events[0].stage, "pr-lifecycle", "stage=流程阶段名（pr-cr-fix 的全链阶段）");
    const preflight = events.filter((e) => e.step === "preflight");
    assert.deepEqual(preflight.map((e) => e.event), ["start", "end"], "preflight 应有 start/end 配对（withStage）");
    const execEnd = events.filter((e) => e.step === "execution" && e.event === "end");
    assert.equal(execEnd.length, 1, "execution end 恰一条");
    assert.equal(execEnd[0].outcome, "failed", "execution end 应带终态 outcome");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  void logs;
});

// ══ dev-merge-gates 双平台产物真实执行（本次新增 pi 执行体，不凭同构声明）══
// 场景 = 发起前预检 fail-fast（git status 脏区）：execution start → gates start/end
//（withStage）→ execution end(outcome=failed)；不执行真实 merge 或 agent。

test("dev-merge-gates pi 产物执行：预检 fail-fast 终态 + execution 事件配对 + outcome", () => {
  const { home, taskId, executionId, ret, err, logs } = runPiProduct(DMG_PI, { gitVariant: "drift" });
  try {
    assert.equal(err, null, `产物执行不应 throw（errored run）：${err}`);
    assert.equal(ret.status, "failed");
    assert.equal(ret.failedStep, "preflight");
    assert.match(ret.error, /工作区不干净/);
    assert.match(ret.recovery, /重新发起/);
    const events = readEvents(home, taskId, executionId);
    for (const rec of events) assertEventShape(rec, taskId, executionId, "dev-merge", { withSkillVersion: true });
    assert.equal(events[0].event, "start");
    assert.equal(events[0].step, "execution");
    assert.equal(events[0].stage, "gates+branch-review");
    // 预检 failure 设置先于 runStep("gates")——gates 被前序失败短路，不产生事件（与
    // 「因前序失败短路的 step 不产生事件」语义一致）；终态只有 execution 配对
    assert.ok(!events.some((e) => e.step === "gates"), "前序失败短路后 gates 不应产生事件");
    const execEnd = events.filter((e) => e.step === "execution" && e.event === "end");
    assert.equal(execEnd.length, 1);
    assert.equal(execEnd[0].outcome, "failed", "execution end 应带终态 outcome");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  void logs;
});

test("dev-merge-gates pi 产物执行：干净区 done 路径 + gates start/end 配对 + outcome=done", () => {
  const { home, taskId, executionId, ret, err } = runPiProduct(DMG_PI, { gitVariant: "default" });
  try {
    assert.equal(err, null, `产物执行不应 throw（errored run）：${err}`);
    assert.equal(ret.status, "done");
    assert.equal(ret.gates, "skipped", "gate 脚本缺失 → 披露跳过（不崩溃不静默）");
    assert.equal(ret.terminated, "skipped", "diff 仅测试/文档外围 → branch-review 披露跳过");
    const events = readEvents(home, taskId, executionId);
    for (const rec of events) assertEventShape(rec, taskId, executionId, "dev-merge", { withSkillVersion: true });
    const gates = events.filter((e) => e.step === "gates");
    assert.deepEqual(gates.map((e) => e.event), ["start", "end"], "gates 应有 start/end 配对（withStage）");
    const execEnd = events.filter((e) => e.step === "execution" && e.event === "end");
    assert.equal(execEnd.length, 1);
    assert.equal(execEnd[0].outcome, "done");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("dev-merge-gates pi 产物执行：invalid-args 早退 → errored run + execution end(outcome=invalid-args)", () => {
  const { home, taskId, executionId, ret, err } = runPiProduct(DMG_PI, {
    argsObj: { maxRounds: 0 },
  });
  try {
    assert.equal(ret, null, "参数校验失败应 throw（errored run）");
    assert.match(err, /参数 maxRounds 非法/);
    const events = readEvents(home, taskId, executionId);
    const execEnd = events.filter((e) => e.step === "execution" && e.event === "end");
    assert.equal(execEnd.length, 1, "invalid-args 早退应有 execution end（failObs 补记）");
    assert.equal(execEnd[0].outcome, "invalid-args");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("dev-merge-gates zcode 产物执行：预检 fail-fast 终态 + 事件经 obsAppend 通道 + outcome", async () => {
  const captured = [];
  const { runProduct, makeMockWorldRun } = await import("./helpers/run-product.mjs");
  const ret = await runProduct(DMG_ZCODE, "zcode", {
    args: { taskId: "selftest-dmg-zc", executionId: "selftest-dmg-zc-exec", sampleType: "selftest" },
    agent: async () => {
      throw new Error("selftest-mock: agent 调用不可用");
    },
    world: { run: makeMockWorldRun(captured, { gitStatus: " M fake-drift.ts\n", obsLayerHash: productObsLayerHash(DMG_ZCODE) }) },
    files: { read: async () => { throw new Error("selftest-mock: 不读文件"); } },
  });
  assert.equal(ret.status, "failed");
  assert.equal(ret.failedStep, "preflight");
  assert.match(ret.error, /工作区不干净/);
  // 预检 failure 先于 runStep("gates")——gates 短路无事件；execution start/end 配对 + outcome
  assert.ok(captured.length >= 2, `至少 execution start/end 两事件（实际 ${captured.length}）`);
  for (const raw of captured) {
    const rec = JSON.parse(raw);
    assertEventShape({ ...rec, timestamp: rec.timestamp || "2026-11-01T00:00:00.000Z" }, "selftest-dmg-zc", "selftest-dmg-zc-exec", "dev-merge", { withSkillVersion: true });
    assert.equal(rec.stage, "gates+branch-review");
  }
  assert.ok(!captured.some((r) => JSON.parse(r).step === "gates"), "前序失败短路后 gates 不应产生事件");
  const execEnd = captured.map((r) => JSON.parse(r)).filter((e) => e.step === "execution" && e.event === "end");
  assert.equal(execEnd.length, 1);
  assert.equal(execEnd[0].outcome, "failed");
});

test("dev-merge-gates zcode 产物执行：invalid-args 早退 → errored + execution end(outcome=invalid-args)", async () => {
  const captured = [];
  const { runProduct, makeMockWorldRun } = await import("./helpers/run-product.mjs");
  await assert.rejects(
    () => runProduct(DMG_ZCODE, "zcode", {
      args: { taskId: "selftest-dmg-ia", executionId: "selftest-dmg-ia-exec", sampleType: "selftest", maxRounds: 0 },
      agent: async () => ({ error: "selftest-mock" }),
      world: { run: makeMockWorldRun(captured, { obsLayerHash: productObsLayerHash(DMG_ZCODE) }) },
      files: { read: async () => { throw new Error("x"); } },
    }),
    /参数 maxRounds 非法/,
  );
  const events = captured.map((r) => JSON.parse(r));
  const execEnd = events.filter((e) => e.step === "execution" && e.event === "end");
  assert.equal(execEnd.length, 1, "invalid-args 早退应有 execution end（failObs 补记）");
  assert.equal(execEnd[0].outcome, "invalid-args");
});

// ══ 失败路径分类动态断言（pr-lifecycle：invalid-args / setup-failure 两类早退）══

test("pr-lifecycle pi 产物：invalid-args 早退 → errored run + execution end(outcome=invalid-args)", () => {
  const { home, taskId, executionId, ret, err } = runPiProduct(PRL_PI, { argsObj: { maxRounds: 0 } });
  try {
    assert.equal(ret, null, "参数校验失败应 throw（errored run）");
    assert.match(err, /参数 maxRounds 非法/);
    const events = readEvents(home, taskId, executionId);
    assert.equal(events[0].step, "execution");
    assert.equal(events[0].event, "start", "home 装配先于参数校验——invalid-args 也有 execution start");
    const execEnd = events.filter((e) => e.step === "execution" && e.event === "end");
    assert.equal(execEnd.length, 1);
    assert.equal(execEnd[0].outcome, "invalid-args");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("pr-lifecycle pi 产物：setup-failure 早退（baseLock 空输出）→ errored + execution end(outcome=setup-failure)", () => {
  const { home, taskId, executionId, ret, err } = runPiProduct(PRL_PI, { gitVariant: "basenull" });
  try {
    assert.equal(ret, null, "setup 失败应 throw（errored run）");
    assert.match(err, /无法解析为 commit/);
    const events = readEvents(home, taskId, executionId);
    const execEnd = events.filter((e) => e.step === "execution" && e.event === "end");
    assert.equal(execEnd.length, 1);
    assert.equal(execEnd[0].outcome, "setup-failure");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("路径穿越拒绝：taskId 含 .. 形态 → 观测告警关闭、零事件文件、业务照常走完失败终态", () => {
  const { home, taskId, executionId, ret, logs } = runPiProduct(PRL_PI, { argsObj: { taskId: "../evil-escape", executionId: "exec-../../escape" } });
  try {
    assert.equal(ret.status, "failed", "观测关闭不影响业务终态");
    const obsDir = join(home, ".agents", "skill-data", "workflow-observability");
    assert.ok(!existsSync(obsDir), "路径穿越 ID 不得创建任何观测目录");
    assert.ok(
      logs.some((l) => l.includes("路径不安全字符")),
      "应有可操作告警（路径不安全字符）",
    );
    void taskId; void executionId;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("zcode 产物执行：obsAppend 经 world.run 捕获，execution end 带 outcome（outcome 契约）", async () => {
  const captured = [];
  const { runProduct, makeMockWorldRun } = await import("./helpers/run-product.mjs");
  const ret = await runProduct(PRL_ZCODE, "zcode", {
    args: { taskId: "selftest-zc-task", executionId: "selftest-zc-exec", sampleType: "selftest" },
    agent: async () => {
      throw new Error("selftest-mock: agent 调用不可用");
    },
    world: { run: makeMockWorldRun(captured, { obsLayerHash: productObsLayerHash(PRL_ZCODE) }) },
    files: { read: async () => { throw new Error("selftest-mock: 不读文件"); } },
  });
  assert.equal(ret.status, "failed");
  assert.ok(captured.length >= 4, `公共层经 obsAppend 至少写 4 个事件（实际 ${captured.length}）`);
  for (const raw of captured) {
    const rec = JSON.parse(raw);
    assertEventShape({ ...rec, timestamp: rec.timestamp || "2026-11-01T00:00:00.000Z" }, "selftest-zc-task", "selftest-zc-exec", "pr-cr-fix", { withSkillVersion: true });
    assert.equal(rec.sample_type, "selftest");
    assert.equal(rec.stage, "pr-lifecycle", "stage 由公共层统一填充（流程阶段名）");
  }
  const execEnd = captured.map((r) => JSON.parse(r)).filter((e) => e.step === "execution" && e.event === "end");
  assert.equal(execEnd.length, 1);
  assert.equal(execEnd[0].outcome, "failed");
});

test("观测可选：不传 taskId/executionId 时零观测（旧调用兼容）", async () => {
  const { runProduct, makeMockWorldRun } = await import("./helpers/run-product.mjs");
  const captured = [];
  const logs = [];
  const ret = await runProduct(PRL_ZCODE, "zcode", {
    args: {},
    agent: async () => ({ error: "selftest-mock" }),
    world: { run: makeMockWorldRun(captured, { obsLayerHash: productObsLayerHash(PRL_ZCODE) }) },
    files: { read: async () => { throw new Error("x"); } },
    report: () => {},
    artifact: { markdown: async () => {} },
    log: (m) => logs.push(String(m)),
  });
  assert.equal(ret.status, "failed");
  assert.equal(captured.length, 0, "未启用观测时不得产生写盘调用");
  assert.ok(!logs.some((l) => l.includes("WARN") && l.includes("观测")), "合法关闭（全缺）不告警");
});

test("观测半配置：只传一个 id 时给可操作提示且不启用（公共层语义）", async () => {
  const { runProduct, makeMockWorldRun } = await import("./helpers/run-product.mjs");
  const captured = [];
  const logs = [];
  await runProduct(PRL_ZCODE, "zcode", {
    args: { taskId: "selftest-only-task" },
    agent: async () => ({ error: "selftest-mock" }),
    world: { run: makeMockWorldRun(captured, { obsLayerHash: productObsLayerHash(PRL_ZCODE) }) },
    files: { read: async () => { throw new Error("x"); } },
    report: () => {},
    artifact: { markdown: async () => {} },
    log: (m) => logs.push(String(m)),
  });
  assert.equal(captured.length, 0);
  assert.ok(
    logs.some((l) => l.includes("观测参数不完整") && l.includes("同时提供")),
    "半配置应有可操作告警（公共层 initObservation 文案）",
  );
});

test("workflow-observe.mjs CLI：10 字段写入 / outcome / 路径穿越 exit 2 / 参数缺失 exit 2", () => {
  const home = mkdtempSync(join(tmpdir(), "wf-obs-cli-"));
  installObsScripts(home);
  const cli = join(home, ".agents", "scripts", "workflow-observe.mjs");
  const env = { ...process.env, HOME: home };
  const run = (args) => spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8" });
  try {
    // ① start 写入（可选 round）
    let r = run(["start", "--task-id", "t1", "--execution-id", "e1", "--skill", "dev-merge",
      "--stage", "merge", "--step", "merge", "--round", "1", "--sample-type", "selftest"]);
    assert.equal(r.status, 0, r.stderr);
    // ② end 带 outcome（终态词）
    r = run(["end", "--task-id", "t1", "--execution-id", "e1", "--skill", "dev-merge",
      "--stage", "merge", "--step", "merge", "--sample-type", "selftest", "--outcome", "completed"]);
    assert.equal(r.status, 0, r.stderr);
    const events = readEvents(home, "t1", "e1");
    assert.equal(events.length, 2);
    for (const rec of events) assertEventShape(rec, "t1", "e1", "dev-merge");
    assert.equal(events[0].outcome, undefined, "start 不带 outcome");
    assert.equal(events[1].outcome, "completed", "end 事件带 outcome 终态词");

    // ③ 路径穿越 ID → exit 2 + 可操作报错
    r = run(["start", "--task-id", "../evil", "--execution-id", "e9", "--skill", "x", "--stage", "s", "--step", "t"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /路径不安全字符/);
    // 结尾点同拒
    r = run(["start", "--task-id", "ok.", "--execution-id", "e9", "--skill", "x", "--stage", "s", "--step", "t"]);
    assert.equal(r.status, 2);

    // ④ 参数缺失（无 id）→ exit 2 用法错误（CLI 无 env 兜底——env 透传是调用方包装职责）
    r = run(["start", "--skill", "x", "--stage", "s", "--step", "t"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /恢复动作/);

    // ⑤ outcome 用在 start → exit 2
    r = run(["start", "--task-id", "t", "--execution-id", "e", "--skill", "x", "--stage", "s", "--step", "t", "--outcome", "x"]);
    assert.equal(r.status, 2);

    // ⑥ 非法 sample-type → exit 2
    r = run(["start", "--task-id", "t", "--execution-id", "e", "--skill", "x", "--stage", "s", "--step", "t", "--sample-type", "wat"]);
    assert.equal(r.status, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("dev-merge.sh 统一命令接线：workflow-observe.mjs（obs-record.mjs 已退役）+ env 短路", () => {
  const sh = readFileSync(DEV_MERGE_SH, "utf8");
  assert.match(sh, /workflow-observe\.mjs/, "dev-merge.sh 应调用统一命令 workflow-observe.mjs");
  assert.ok(!sh.includes("obs-record"), "obs-record.mjs 已退役，dev-merge.sh 不得再引用");
  assert.match(sh, /WORKFLOW_OBS_TASK_ID/, "env 透传（taskId）");
  assert.match(sh, /WORKFLOW_OBS_EXECUTION_ID/, "env 透传（executionId）");
  // env 短路：未配置 id 时不发起 CLI 调用（避免用法错误输出污染脚本结果）
  assert.match(sh, /\[\[ -n "\$\{WORKFLOW_OBS_TASK_ID:-\}" && -n "\$\{WORKFLOW_OBS_EXECUTION_ID:-\}" \]\] \|\| return 0/);
  // 阶段边界调用形态：obs <event> <stage> <step>
  for (const call of ["obs start merge merge", "obs end merge merge", "obs start cleanup cleanup", "obs end cleanup cleanup"]) {
    assert.ok(sh.includes(call), `dev-merge.sh 缺观测边界调用 "${call}"`);
  }
});
