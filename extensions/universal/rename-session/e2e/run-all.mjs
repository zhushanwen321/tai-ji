#!/usr/bin/env node
/**
 * rename-session E2E 总结 runner：顺序跑 A1-A7，单场景失败不阻断后续，
 * 最后汇总表 + 总 exit code（任一失败——含 KEBAB_NON_COMPLIANT——→ 1）。
 *
 * 两种模式：
 * - 默认（无 env）：全量 A1-A7（真实 pi + 真实模型，约 2-15 分钟）——人工验收用。
 * - E2E_QUICK=1：只跑 harness 断言工具单测（vitest，秒级）——cw test gate 用。
 *   cw 的 testRunner 硬编码 120s 命令超时，真实模型的 E2E 全量必超；E2E 场景的
 *   正式验收证据是 RESULTS.md + 各场景独立跑记录（见 README），gate 跑快速集
 *   验证 harness 逻辑与 runner 健康。
 *
 * 用法：cd extensions/universal/rename-session && node e2e/run-all.mjs
 * 调试保留现场：E2E_KEEP_TMP=1 node e2e/run-all.mjs
 */

import { spawnSync } from "node:child_process";

// 场景模块置顶 import（ESM 静态 import 无论书写位置都被 hoist——下面的 E2E_QUICK 早退
// 分支放在 import 后也不会跳过模块加载，置顶声明消除「quick 模式不加载场景模块」的误读）
import { runA1 } from "./run-a1.mjs";
import { runA2 } from "./run-a2.mjs";
import { runA3 } from "./run-a3.mjs";
import { runA4 } from "./run-a4.mjs";
import { runA5 } from "./run-a5.mjs";
import { runA6 } from "./run-a6.mjs";
import { runA7 } from "./run-a7.mjs";

if (process.env.E2E_QUICK === "1") {
	// 快速集：harness 断言工具单测（vitest 输出原生含统计行，gate 正则直接消费）
	const r = spawnSync("npx", ["vitest", "run", "e2e/harness.test.mjs"], {
		stdio: "inherit",
		encoding: "utf8",
		timeout: 110_000, // cw testRunner 硬上限 120s 内留余量
	});
	process.exit(r.status ?? 1);
}

const SCENARIOS = [
	{ name: "A1", run: runA1 },
	{ name: "A2", run: runA2 },
	{ name: "A3", run: runA3 },
	{ name: "A4", run: runA4 },
	{ name: "A5", run: runA5 },
	{ name: "A6", run: runA6 },
	{ name: "A7", run: runA7 },
];

const t0 = Date.now();
const results = [];
for (const s of SCENARIOS) {
	console.log(`\n════════ ${s.name} ════════`);
	// runScenario 内部 catch（失败不阻断后续），此处 await 不会抛
	results.push(await s.run());
}

// ── 汇总 ──
console.log(`\n════════ E2E 汇总（${((Date.now() - t0) / 1000).toFixed(1)}s）════════`);
for (const r of results) {
	const status = r.ok ? "PASS" : `FAIL [${r.kind ?? "assertion"}]`;
	const kebab = r.kebabNonCompliant ? `  KEBAB_NON_COMPLIANT: "${r.kebabNonCompliant.title}"（模型遵从问题，人工按 spec 处置）` : "";
	console.log(`${r.name}: ${status} (${(r.durationMs / 1000).toFixed(1)}s)${kebab}`);
}
const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
	console.log(`\n失败明细（${failed.length} 个）:`);
	for (const r of failed) console.log(`  ${r.name} [${r.kind ?? "assertion"}]: ${r.error?.message ?? ""}`);
}

// vitest 兼容统计行（机器可消费）：cw test gate 等工具链用 `N passed` / `N failed`
// 正则解析汇总（取最后一个匹配）。KEBAB_NON_COMPLIANT 场景 r.ok 仍为 true（人工处置路径），
// 但机器统计须计为 failed——与 e2e/scenarios.test.mjs 的 gate 语义（该情况 test 失败）一致。
const passed = results.filter((r) => r.ok && !r.kebabNonCompliant).length;
const gateFailedCount = results.length - passed;
const exit = gateFailedCount > 0 ? 1 : 0;
console.log(`\nexit code: ${exit}`);
console.log(`\nTest Files  1 ${gateFailedCount > 0 ? "failed" : "passed"} (1)`);
console.log(`Tests  ${passed} passed${gateFailedCount > 0 ? ` | ${gateFailedCount} failed` : ""} (${results.length})`);
process.exitCode = exit;
