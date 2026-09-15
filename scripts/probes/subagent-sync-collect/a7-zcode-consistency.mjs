#!/usr/bin/env node
// scripts/probes/subagent-sync-collect/a7-zcode-consistency.mjs
//
// [A7] zcode 引擎一致性（手动执行模板）
// 设计 docs/design/subagent-sync-collect.md §4 验收表 A7 行（设计文档已删，git 可追溯）：
//   与 A1 同构但引擎路由 zcode（同轮 3 个 collect:"sync" start，sleep 10s/30s/60s）。
//   本脚本不实际执行（zcode 引擎需本机 CLI 与配置）——只做：
//     1) 参数检查（extensions / pi 二进制 / 模型 / <agentDir>/subagents/config.json
//        引擎路由字段 / zcode CLI 存在性）
//     2) 手动执行指引输出（命令行 + engine:"zcode" 派发 prompt 模板 + 观察门）
//     3) RESULTS.md 记录表格模板落盘
// 预期输出：
//   - 参数检查清单（OK / 缺失 + 处置指引；config 与 zcode CLI 为 NOTE 级不设门）
//   - 可直接复制粘贴的手动执行步骤（zcode 路由两种方式：config defaultEngine / 调用点 engine 参数）
//   - RESULTS.md 追加 A7 记录表格模板
//
// 用法：node a7-zcode-consistency.mjs [--dry-run]
//   PI_PROBE_MODEL 覆盖模型（缺省 xiaomi-token-plan-cn/mimo-v2.5-pro）
//   PI_CODING_AGENT_DIR 覆盖 agentDir（config.json 路径随之推导）

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as C from "./common.mjs";

const SCENARIO = "A7";
const DESIGN = "subagent-sync-collect.md §4 验收表 A7（zcode 引擎一致性：与 A1 同构，手动执行模板）";
const EXPECT = "参数检查清单 + 手动执行指引（engine:'zcode' prompt 模板）+ RESULTS.md 表格模板；不 spawn pi";

const SLEEPS = [10, 30, 60];

function whichBin(name) {
  try {
    return execFileSync("which", [name], { stdio: ["pipe", "pipe", "pipe"] }).toString().trim() || null;
  } catch {
    return null;
  }
}

/** <agentDir>/subagents/config.json（引擎路由 SSOT；不存在/解析失败 = 运行时静默回默认 pi）。 */
function readEngineConfig() {
  const file = join(C.resolveAgentDir(), "subagents", "config.json");
  if (!existsSync(file)) return { file, exists: false };
  try {
    return { file, exists: true, cfg: JSON.parse(readFileSync(file, "utf-8")) };
  } catch (err) {
    return { file, exists: true, parseError: err && err.message ? err.message : String(err) };
  }
}

function indent(text, pad = "   ") {
  return text
    .split("\n")
    .map((l) => (l.trim() ? pad + l : l))
    .join("\n");
}

function buildManualGuide() {
  const model = C.resolveModel();
  const cfg = readEngineConfig();
  const configSample = JSON.stringify(
    { version: 1, defaultEngine: "zcode", engineRouting: { strict: false }, maxConcurrent: 6 },
    null,
    2,
  );
  const piArgs = [
    "pi --no-extensions",
    `  --extension ${C.SW_EXTENSION}`,
    `  --extension ${C.SR_EXTENSION}`,
    "  --no-builtin-tools --no-context-files",
    "  --mode rpc --session-dir <mkdtemp 目录>",
    `  --model ${model}`,
    "  --approve",
  ].join(" \\\n");
  const promptTemplate = C.dispatchPrompt({
    starts: SLEEPS.map((s) => ({
      task:
        `You MUST actually run this exact bash command first: sleep ${s} && echo marker-${s}. ` +
        `After it finishes, reply with exactly: done-${s}`,
      slug: `z-sleep-${s}s`,
      collect: "sync",
      engine: "zcode",
    })),
  });
  return [
    `── ${SCENARIO} 手动执行指引（与 A1 同构，引擎路由 zcode）──`,
    "",
    "1) 引擎路由二选一（新 session 生效；session 内不重读配置）：",
    `   a. 全局默认：写 ${cfg.file}：`,
    indent(configSample, "      "),
    "   b. 调用点覆盖：派发 prompt 每个 start 显式带 engine: \"zcode\"（下方模板已带）。",
    "      注意三层优先级：工具 engine 参数 > agent frontmatter engine > defaultEngine；",
    "      显式指定（a 层级 1/2）probe 失败不兜底，直接报 engine_probe_failed。",
    "",
    "2) 起 pi（与 A1 同 flag）：",
    indent(piArgs),
    "",
    "3) 发派发 prompt（同轮 3 个 start，collect:sync + engine:zcode）：",
    indent(promptTemplate),
    "",
    "4) 观察门（与 A1 相同 + 引擎证据）：",
    "   - 恰 1 条 subagent-bg-notify 批通知；批头 `Subagent batch completed: 3 finished, 0 failed, 0 cancelled.`",
    "   - 批闭合前主 agent 零新增 turn；批通知距派发 ≥50s（最慢成员 sleep 60s 主导闭合）",
    "   - zcode 生效证据：record.engine == \"zcode\"；非 pi 引擎 journal 落 <dataDir>/engines/<engineId>/",
    "   - 无 engineFallback 标记（显式指定不兜底；若出现即路由语义回归）",
    "   - zcode 不支持 conversation/fork/worktree 参数（预检拒绝）——本场景不传，不涉及",
    "",
    "5) 把观察结果填入 RESULTS.md 的 A7 表格模板（本脚本已追加）。",
    "",
  ].join("\n");
}

async function main() {
  if (C.isDryRun(process.argv)) {
    process.exit(
      C.dryRunReport({
        scenarioId: SCENARIO,
        design: DESIGN,
        expect: EXPECT,
        scriptFile: import.meta.url,
        plan: [
          "参数检查（不 spawn pi）：extensions 存在 / pi 二进制可解析 / 模型解析（NOTE）",
          "引擎路由参数检查（NOTE 级）：<agentDir>/subagents/config.json 的 defaultEngine/engineRouting.strict/maxConcurrent",
          "zcode CLI 存在性预检（NOTE 级；运行时引擎 probe 另做存在性/版本检查并缓存）",
          "输出手动执行指引（config 示例 + pi 命令行 + engine:'zcode' 派发 prompt 模板 + 观察门）",
          "RESULTS.md 追加 A7 记录表格模板",
        ],
      }),
    );
  }

  const checks = C.makeChecks();

  // ── 参数检查 ──
  const swOk = existsSync(join(C.SW_EXTENSION, "package.json"));
  const srOk = existsSync(join(C.SR_EXTENSION, "package.json"));
  checks.check("subagent-workflow extension 存在", swOk, C.SW_EXTENSION);
  checks.check("session-reader extension 存在", srOk, C.SR_EXTENSION);

  const piBin = C.resolvePiBin();
  const piOk = piBin === "pi" ? !!whichBin("pi") : existsSync(piBin);
  checks.check("pi 二进制可解析", piOk, C.piBinDescription(piBin));

  checks.note(
    "模型",
    `${C.resolveModel()}${process.env.PI_PROBE_MODEL ? " (PI_PROBE_MODEL)" : " (默认)"}`,
  );

  // ── 引擎路由配置（NOTE 级：手动场景预检，不设门）──
  const cfgInfo = readEngineConfig();
  if (!cfgInfo.exists) {
    checks.note("引擎路由 config.json 未配置（运行时默认 pi）——zcode 手动跑前需写入（见指引第 1 步）", cfgInfo.file);
  } else if (cfgInfo.parseError) {
    checks.note("config.json 解析失败（运行时静默回默认 pi，不报错）", `${cfgInfo.file}: ${cfgInfo.parseError}`);
  } else {
    const cfg = cfgInfo.cfg;
    checks.note(
      "defaultEngine",
      typeof cfg.defaultEngine === "string" ? cfg.defaultEngine : "(未设/非法 → pi)",
    );
    checks.note(
      "engineRouting.strict",
      cfg.engineRouting && typeof cfg.engineRouting.strict === "boolean" ? String(cfg.engineRouting.strict) : "(未设 → false)",
    );
    checks.note(
      "maxConcurrent",
      typeof cfg.maxConcurrent === "number" && Number.isInteger(cfg.maxConcurrent) && cfg.maxConcurrent > 0
        ? String(cfg.maxConcurrent)
        : "(未设/非法 → 6)",
    );
  }

  const zcodePath = whichBin("zcode");
  checks.note(
    "zcode CLI（PATH 预检；运行时引擎 probe 另做存在性/版本检查并缓存至进程存活期）",
    zcodePath || "未找到——显式 engine:'zcode' 派发将报 engine_probe_failed（不兜底）",
  );

  // ── 手动执行指引 ──
  console.log(buildManualGuide());

  // ── 记录表格模板 ──
  C.appendResultRecord(SCENARIO, [
    "| 项 | 值 |",
    "|---|---|",
    "| 批通知条数（预期 1） | |",
    "| 批头（预期 3 finished, 0 failed, 0 cancelled） | |",
    "| 批闭合前新增 turn（预期 0） | |",
    "| 派发→批通知时延（预期 ≥50s） | |",
    "| zcode 生效证据（record.engine / engines journal） | |",
    "| engineFallback 标记（预期无） | |",
  ]);

  checks.finish(SCENARIO);
}

C.runScenario(SCENARIO, main);
