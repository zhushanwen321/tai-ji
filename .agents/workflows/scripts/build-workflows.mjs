#!/usr/bin/env node
// build-workflows.mjs — workspace 双平台 workflow 脚本构建器（单源拼接路线）
//
// 源（workflows/src/）：
//   <name>.shared.ts      单源公共体（TS、zcode 原生形态；字面 agent( 调用 + ask<T> 泛型
//                         ——zcode GUI 泳道的编译期静态分析依赖字面 agent( 调用点，禁止
//                         包函数遮蔽）
//   <name>.zcode.tpl.ts   zcode 壳（frontmatter + 平台钩子（obsNow/obsAppend）+ @@STITCH@@）
//   <name>.pi.tpl.js      pi 壳（@pi-meta + shim（args/wfAgent/world/files/report/artifact/
//                         obsNow/obsAppend）+ @@STITCH@@）
// 公共观测层（O 区单一构建输入，安装 symlink）：
//   ~/.agents/scripts/workflow-observability.shared.ts
//   （= zsw 仓 workflows/src/observability.shared.ts 的安装副本）。shared 正文含
//   initObservation 调用点即视为已接入观测：构建时把公共层全文拼在业务正文之前
//   （obsCtx 为 let，业务顶层赋值依赖声明在前）；缺失 = 构建失败（不允许静默退回
//   无观测产物）。观测层只此一份，业务 shared 与壳禁止拷贝其副本。
// 产物（生成物，禁止手工维护）：
//   workflows/<name>.dwf.ts                    zcode 版（CreateWorkflow path 发起）
//   workflows/<name>.js                        pi 版（workflow 工具 action=run + 绝对路径）
//   例外：pr-lifecycle 的 zcode 产物落 .agents/skills/pr-cr-fix/workflows/pr-lifecycle.dwf.ts
//   （既有调用路径，改动会中断 SKILL.md 引用与发起方习惯）
//
// pi 管线（zcode 产物 = 壳 + 观测层 + shared 原文，零转换）：
//   ① 词法安全改写：代码区的 agent( → wfAgent(（字符串/模板/注释/正则内不动）。
//      pi worker 以同作用域 function 声明拼入平台 agent，壳内同名声明会静默覆盖它，
//      壳内调用将递归——改写后壳的 wfAgent 体内才能安全调用平台原生 agent
//   ② .ask<T>( → .ask("T", ：泛型参数转 typeKey 字符串，pi 壳据此查 SCHEMA_BY_KEY
//   ③ typescript.transpileModule 剥 TS（interface/as/非空!/类型谓词/泛型函数）
//
// 用法：node .agents/workflows/scripts/build-workflows.mjs [--check]
//   默认构建全部产物；--check 校验产物与重生成结果一致（pre-commit / CI 防改源忘构建）
//   typescript 解析顺序：env WORKFLOW_BUILD_TYPESCRIPT → node 解析链 →
//   ~/Code/zsw-skills 的 node_modules（构建期工具依赖，经 os.homedir() 动态推导）。
//
// 观测契约（O 区三源同步锚，构建时核对）：
//   observability.shared.ts（单一观测层）/ 本文件 OBS_EVENT_FIELDS、OBS_STAGES、OBS_STEPS /
//   ~/.agents/scripts/workflow-observe.mjs（workflow 外步骤记录命令）。改事件字段或
//   阶段词表必须三处同步。

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { homedir } from "node:os";

const WF = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(WF, "src");
// pr-lifecycle 的 zcode 产物保持既有调用路径（.agents/skills/pr-cr-fix/workflows/）
const PRL_ZCODE_OUT = join(WF, "..", "skills", "pr-cr-fix", "workflows", "pr-lifecycle.dwf.ts");
const NAMES = ["dev-merge-gates", "pr-lifecycle"];
const OUTS = {
  "dev-merge-gates": { zcode: join(WF, "dev-merge-gates.dwf.ts"), pi: join(WF, "dev-merge-gates.js") },
  "pr-lifecycle": { zcode: PRL_ZCODE_OUT, pi: join(WF, "pr-lifecycle.js") },
};

// ── O 区安装位（经 homedir() 动态推导，产物内无本机路径）──
const OBS_LAYER_PATH = join(homedir(), ".agents", "scripts", "workflow-observability.shared.ts");
const OBS_CLI_PATH = join(homedir(), ".agents", "scripts", "workflow-observe.mjs");

// ── 观测契约（O 区）：三源同步锚──
const OBS_EVENT_FIELDS = ["execution_id", "task_id", "skill", "stage", "step", "round", "attempt", "event", "timestamp", "sample_type"];
// 观测归属词表（initObservation 前两实参；统计按 skill/stage 筛选，引擎名不进事件）：
// skill = 业务所属 skill 名；stage = 业务所属流程阶段名（gates+branch-review =
// dev-merge-gates 承载的 dev-merge 两个流程阶段的连接标识；pr-lifecycle = pr-cr-fix 的
// 全链阶段）
const OBS_SKILLS = new Set(["dev-merge", "pr-cr-fix"]);
const OBS_STAGES = new Set(["gates+branch-review", "pr-lifecycle"]);
// step 词表 = 串行步骤名（execution = 执行级边界事件；round 为直发轮次边界，不占打开槽）
const OBS_STEPS = new Set([
  "execution", "gates", "branch-review", "review", "aggregate", "fix", "round",
  "preflight", "static-gate", "pr-meta", "pr-submit", "constraints",
  "gate-suite", "cr-fix", "simplify", "final-gates",
]);

// typescript 从安装环境解析（env 覆盖 → node 解析链 → ~/Code/zsw-skills node_modules）
function loadTypescript() {
  if (process.env.WORKFLOW_BUILD_TYPESCRIPT) {
    try {
      return createRequire(import.meta.url)(process.env.WORKFLOW_BUILD_TYPESCRIPT);
    } catch {
      throw new Error(`WORKFLOW_BUILD_TYPESCRIPT 指向的 typescript 不可用：${process.env.WORKFLOW_BUILD_TYPESCRIPT}——修正该环境变量或删除后走默认解析链`);
    }
  }
  try {
    return createRequire(import.meta.url)("typescript");
  } catch {
    // fallthrough
  }
  const zswTs = join(homedir(), "Code", "zsw-skills", "node_modules", "typescript");
  try {
    return createRequire(import.meta.url)(zswTs);
  } catch {
    throw new Error(
      "typescript 不可用（构建期依赖）：node 解析链与 " + zswTs + " 均未命中。" +
      "恢复动作：cd ~/Code/zsw-skills && pnpm install（该仓 devDependencies 含 typescript），或设 WORKFLOW_BUILD_TYPESCRIPT=<typescript 入口绝对路径> 后重跑本脚本",
    );
  }
}
const ts = loadTypescript();

const STITCH = /^\s*@@STITCH@@\s*$/;

// ── 拼接：标记行替换为 shared 全文（保持标记行缩进） ──
function stitch(template, shared) {
  const out = [];
  let replaced = 0;
  for (const line of template.split("\n")) {
    if (STITCH.test(line)) {
      replaced++;
      const indent = line.match(/^\s*/)[0];
      out.push(shared.split("\n").map((l) => (l === "" ? "" : indent + l)).join("\n"));
    } else {
      out.push(line);
    }
  }
  if (replaced !== 1) throw new Error(`模板应有恰好 1 个 @@STITCH@@ 标记行，实际 ${replaced}`);
  return out.join("\n");
}

// ── 词法扫描：输出段列表 { code, text }——code=true 的段是可改写区，其余原样透传 ──
// （状态机与全局 review-fix-loop 族构建器同款设计）
function lexSegments(src) {
  const segments = [];
  let i = 0;
  const n = src.length;
  let prevSig = "\n";
  const REGEX_PRECEDING = new Set(["(", "[", "{", ",", ";", ":", "=", "!", "&", "|", "?", "+", "-", "*", "%", "<", ">", "~", "^", "\n"]);
  const REGEX_KEYWORDS = new Set(["return", "case", "do", "else", "in", "of", "typeof", "void", "delete", "yield", "await"]);
  const codeStart = () => {
    const last = segments[segments.length - 1];
    if (last && last.code) return last;
    const seg = { code: true, text: "" };
    segments.push(seg);
    return seg;
  };
  const rawStart = () => {
    const last = segments[segments.length - 1];
    if (last && !last.code) return last;
    const seg = { code: false, text: "" };
    segments.push(seg);
    return seg;
  };
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      const j = src.indexOf("\n", i);
      rawStart().text += src.slice(i, j < 0 ? n : j);
      i = j < 0 ? n : j;
      prevSig = "\n";
    } else if (c === "/" && src[i + 1] === "*") {
      const j = src.indexOf("*/", i + 2);
      const end = j < 0 ? n : j + 2;
      rawStart().text += src.slice(i, end);
      i = end;
      prevSig = "\n";
    } else if (c === "/" && (REGEX_PRECEDING.has(prevSig) || (/[A-Za-z_$]/.test(prevSig) && REGEX_KEYWORDS.has(prevWord())))) {
      const start = i;
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== "\n") {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
        else if (src[j] === "/" && !inClass) break;
        j++;
      }
      rawStart().text += src.slice(start, j);
      i = j;
      prevSig = "/";
    } else if (c === '"' || c === "'") {
      const start = i;
      let j = i + 1;
      while (j < n && src[j] !== c) { if (src[j] === "\\") j += 2; else j++; }
      rawStart().text += src.slice(start, Math.min(j + 1, n));
      i = j + 1;
      prevSig = c;
    } else if (c === "`") {
      const start = i;
      let j = i + 1;
      let depth = 0;
      while (j < n && (src[j] !== "`" || depth > 0)) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === "$" && src[j + 1] === "{") { depth++; j += 2; continue; }
        if (src[j] === "}" && depth > 0) { depth--; j++; continue; }
        if (depth === 0) { j++; continue; }
        j++;
      }
      rawStart().text += src.slice(start, Math.min(j + 1, n));
      i = j + 1;
      prevSig = "`";
    } else {
      codeStart().text += c;
      if (!" \t\r".includes(c)) prevSig = c;
      i++;
    }
  }
  function prevWord() {
    let j = i;
    while (j > 0 && /[A-Za-z_$]/.test(src[j - 1])) j--;
    return src.slice(j, i);
  }
  return segments;
}

// ── pi 管线 ①：代码区 agent( → wfAgent(（词法安全，字符串/注释/正则内不动） ──
function rewriteAgentCalls(src) {
  const segments = lexSegments(src);
  let count = 0;
  for (const seg of segments) {
    if (!seg.code) continue;
    seg.text = seg.text.replace(/(?<![\w.$])agent\(/g, () => { count++; return "wfAgent("; });
  }
  return { text: segments.map((s) => s.text).join(""), count };
}

// ── pi 管线 ②③：ask 泛型转 typeKey + transpile 剥 TS ──
function stripTs(sharedTs) {
  const pre = sharedTs.replace(/\.\s*ask<([A-Za-z_$][\w$]*)>\(/g, '.ask("$1", ');
  const { outputText, diagnostics } = ts.transpileModule(pre, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    reportDiagnostics: true,
  });
  const errs = (diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errs.length > 0) {
    throw new Error("TS 剥离诊断失败：" + errs.map((d) => ts.flattenDiagnosticMessageText(d.messageText, " ")).join("; "));
  }
  return outputText;
}

// ── 产物恒定检查：本机绝对路径字面不得进产物（workspace 约定；os.homedir() 动态推导除外） ──
function assertNoLocalPath(product, rel) {
  const home = homedir();
  if (product.includes(home + "/")) {
    throw new Error(`${rel} 含本机绝对路径字面（${home}/...）——workspace 约定禁止；引用位置改用 ~/.agents/... 占位或运行时 os.homedir() 推导`);
  }
}

// ── 观测契约核对（构建期门禁）：stage/step 词表、事件字段（对照单一观测层）、execution
//    级边界与终态统一补记出口在场、两侧产物步骤调用点与 shared 一致、ID 安全规则与
//    workflow-observe.mjs 字面一致。未接入的 workflow 显式说明跳过（不静默漏检） ──
function checkObservationContract(name, shared, obsLayer, zcOut, piOut, obsCli, errors) {
  // 双实参提取（调用形态固定为两个字面量）：组 1 = skill、组 2 = stage
  const stageHits = [...shared.matchAll(/initObservation\("([^"]+)",\s*"([^"]+)"/g)];
  if (stageHits.length === 0) {
    console.log(`  观测契约：${name} 未接入观测（无 initObservation 调用点）——跳过观测维度（产物一致性检查照常）`);
    return;
  }
  const stageSet = new Set(stageHits.map((m) => m[2]));
  for (const m of stageHits) {
    if (!OBS_SKILLS.has(m[1])) errors.push(`${name}: 观测 skill「${m[1]}」不在词表（合法：${[...OBS_SKILLS].join("/")}）——skill=业务所属 skill 名，不是引擎/workflow 名`);
  }
  const stepExtractor = (text) =>
    [...text.matchAll(/\b(?:obsBegin|withStage)\("([A-Za-z0-9-]+)"/g)].map((m) => m[1]).sort();
  const sharedSteps = stepExtractor(shared);
  for (const st of stageSet) {
    if (!OBS_STAGES.has(st)) errors.push(`${name}: 观测 stage「${st}」不在词表（合法：${[...OBS_STAGES].join("/")}）——新阶段先登记 OBS_STAGES`);
  }
  for (const s of sharedSteps) {
    if (!OBS_STEPS.has(s)) errors.push(`${name}: 观测 step「${s}」不在词表（合法：${[...OBS_STEPS].join("/")}）——新步骤名先登记 OBS_STEPS`);
  }
  if (!sharedSteps.includes("execution") && !/obsEmit\("execution"/.test(shared)) {
    errors.push(`${name}: 观测已接入但无 execution 级边界事件（obsEmit("execution", ...)）——每次执行的 JSONL 须有执行级 start/end`);
  }
  if (!/obsCloseExecution\(/.test(shared)) {
    errors.push(`${name}: 观测已接入但无终态统一补记出口（obsCloseExecution 调用点）——异常/终态离开时打开中的 step 与 execution 缺 end 配对`);
  }
  for (const f of OBS_EVENT_FIELDS) {
    if (!obsLayer.includes(f)) errors.push(`${name}: 观测事件契约缺字段 ${f}（三源同步：observability.shared.ts / build-workflows OBS_EVENT_FIELDS / workflow-observe.mjs）`);
  }
  // ID 安全规则一致（公共层 obsSafeId 与 CLI safeId 同一正则字面——漂移即两套语义）
  const idRule = (text) => (text.match(/\/\^[^\n/]*\{\d+,\d+\}\$\//) ?? [])[0];
  const sharedIdRule = idRule(obsLayer);
  const cliIdRule = idRule(obsCli);
  if (sharedIdRule !== cliIdRule) {
    errors.push(`观测 ID 安全规则漂移：observability.shared.ts 的 obsSafeId（${sharedIdRule || "未提取"}）≠ workflow-observe.mjs 的 safeId（${cliIdRule || "未提取"}）——两处须同一正则字面（路径穿越防线单一语义）`);
  }
  const zcSteps = stepExtractor(zcOut);
  const piSteps = stepExtractor(piOut);
  const sameSet = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  if (!sameSet(sharedSteps, zcSteps)) errors.push(`${name}: zcode 产物的观测步骤调用点（${zcSteps.join(",") || "无"}）与 shared（${sharedSteps.join(",") || "无"}）不一致`);
  if (!sameSet(sharedSteps, piSteps)) errors.push(`${name}: pi 产物的观测步骤调用点（${piSteps.join(",") || "无"}）与 shared（${sharedSteps.join(",") || "无"}）不一致——pi 改写/TS 剥离管线不应影响观测调用点`);
  if (errors.length === 0) {
    const skillSet = new Set(stageHits.map((m) => m[1]));
    console.log(`  观测契约：${name} skill=${[...skillSet].join("/")} stage=${[...stageSet].join("/")} steps=${sharedSteps.join("/")}（两侧调用点一致，字段齐全，ID 规则与 CLI 一致）`);
  }
}

const check = process.argv.includes("--check");
let dirty = 0;

// O 区单一构建输入（安装 symlink；缺失 = 构建失败，给安装恢复动作）
const obsLayer = (() => {
  try {
    return readFileSync(OBS_LAYER_PATH, "utf8");
  } catch {
    throw new Error(
      `公共观测层缺失：${OBS_LAYER_PATH}——观测层是单一构建输入，缺失时不得生成无观测产物。` +
      "恢复动作：确认 zsw 技能仓已安装（~/.agents/scripts/workflow-observability.shared.ts 为 zsw 仓 workflows/src/observability.shared.ts 的安装 symlink；ln -s <zsw 仓>/skills/self/dev-workflow/workflows/src/observability.shared.ts ~/.agents/scripts/workflow-observability.shared.ts）后重跑",
    );
  }
})();
const obsCli = (() => {
  try {
    return readFileSync(OBS_CLI_PATH, "utf8");
  } catch {
    throw new Error(
      `观测记录命令缺失：${OBS_CLI_PATH}——构建器核对 ID 安全规则与 CLI 的一致性依赖该文件。` +
      "恢复动作：ln -s <zsw 仓>/scripts/workflow-observe.mjs ~/.agents/scripts/workflow-observe.mjs 后重跑",
    );
  }
})();

for (const name of NAMES) {
  const sharedPath = join(SRC, `${name}.shared.ts`);
  const zcTplPath = join(SRC, `${name}.zcode.tpl.ts`);
  const piTplPath = join(SRC, `${name}.pi.tpl.js`);
  let shared, zcTpl, piTpl;
  try {
    shared = readFileSync(sharedPath, "utf8");
    zcTpl = readFileSync(zcTplPath, "utf8");
    piTpl = readFileSync(piTplPath, "utf8");
  } catch (e) {
    console.error(`✗ ${name}: 源缺失（${e.message.split("\n")[0]}）——三件套（shared/zcode.tpl/pi.tpl）必须齐备`);
    dirty++;
    continue;
  }

  // O 区观测层拼接：shared 正文含 initObservation 调用点 → 观测层全文前置
  const obsPatched = /initObservation\(/.test(shared);
  const sharedFull = obsPatched ? `${obsLayer}\n${shared}` : shared;

  const rewritten = rewriteAgentCalls(shared);
  if (rewritten.count === 0) throw new Error(`${name}: 公共体未发现 agent( 调用点——切分错误或调用点被遮蔽`);
  const rewrittenFull = rewriteAgentCalls(sharedFull);
  if (rewrittenFull.count !== rewritten.count) {
    throw new Error(`${name}: 观测层中出现 agent( 调用点（不应发生——观测层不派 agent）`);
  }
  const piShared = stripTs(rewrittenFull.text);
  const zcOut = stitch(zcTpl, sharedFull);
  const piOut = stitch(piTpl, piShared);

  // 观测契约核对（构建期门禁）
  const obsErrors = [];
  checkObservationContract(name, shared, obsLayer, zcOut, piOut, obsCli, obsErrors);
  if (obsErrors.length > 0) {
    for (const e of obsErrors) console.error(`✗ ${e}`);
    dirty += obsErrors.length;
    continue;
  }

  const targets = [
    [OUTS[name].zcode, zcOut],
    [OUTS[name].pi, piOut],
  ];
  for (const [path, content] of targets) {
    const rel = path.startsWith(WF) ? path.slice(WF.length + 1) : path;
    assertNoLocalPath(content, rel);
    const existing = (() => { try { return readFileSync(path, "utf8"); } catch { return null; } })();
    if (existing === content) {
      console.log(`✓ ${rel}（一致）`);
    } else if (check) {
      console.error(`✗ ${rel} 与重生成结果不一致（产物过期）——恢复动作：node .agents/workflows/scripts/build-workflows.mjs`);
      dirty++;
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
      console.log(`已生成 ${rel}`);
    }
  }
}

if (check && dirty > 0) {
  console.error(`\n${dirty} 个问题。恢复动作：node .agents/workflows/scripts/build-workflows.mjs`);
  process.exit(1);
}
