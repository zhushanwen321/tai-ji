/**
 * E2E 场景 A1-A7 的 vitest 包装（cw test gate 兼容）。
 *
 * 背景：cw test gate 用 vitest 输出解析器统计 `N passed` / `N failed`，
 * `node e2e/run-all.mjs` 的自定义表格输出解析不到（passed=0）。本文件把 7 个
 * 场景包装成 vitest test（从 run-aN.mjs import 场景函数），gate 即可统计。
 *
 * gate 语义转换：runScenario 内部 catch 不抛（单场景失败不阻断后续），返回
 * { ok, kind?, error?, logs }；vitest test 视角必须把不 ok 转为 throw 使 test 失败。
 * A2 的 KEBAB_NON_COMPLIANT（模型遵从问题）在独立执行路径不翻 exit code、交人工处置，
 * 但在 gate 语义下计失败（throw 含实际标题）——与 run-a2.mjs 头注释的处置约定一致。
 *
 * 真实模型 + 真实 pi 子进程，串行跑全量约 5-6 分钟（A2 三个 session 最长）。
 * 人工汇总 runner 仍是 e2e/run-all.mjs（输出四分类汇总 + RESULTS.md 追加），与本文件互补。
 */

import { describe, it } from "vitest";

import { runA1 } from "./run-a1.mjs";
import { runA2 } from "./run-a2.mjs";
import { runA3 } from "./run-a3.mjs";
import { runA4 } from "./run-a4.mjs";
import { runA5 } from "./run-a5.mjs";
import { runA6 } from "./run-a6.mjs";
import { runA7 } from "./run-a7.mjs";

/**
 * 场景结果 → gate 语义：ok=false 或 A2 kebab 非合规时 throw（vitest test 失败）。
 * 错误信息带失败分类 + 完整场景日志（runScenario 已把 FAIL 行与 stack 收进 logs）。
 */
function toGate(result) {
	if (!result.ok) {
		throw new Error(
			`[${result.name}] FAIL [${result.kind ?? "assertion"}]: ${result.error?.message ?? result.error}\n` +
				result.logs.join("\n"),
		);
	}
	if (result.kebabNonCompliant) {
		const k = result.kebabNonCompliant;
		throw new Error(
			`[${result.name}] KEBAB_NON_COMPLIANT [${k.label}] 实际标题 "${k.title}": ${k.violation}` +
				`（模型遵从问题，按 spec 人工处置路径；gate 语义计失败）`,
		);
	}
}

// 包装超时按「场景内部等待最坏和 × 1.2 余量」取值（模型延迟变慢日也会被 vitest 掐断的场景，
// 独立 runner 能跑完——wrapper 契约必须 ≥ 场景契约，否则 spawnPi 子进程/tmp 在 finally 前泄漏）：
//   A1：settled/message_end 并行 180s + renamed 45s + 落盘轮询 10s = 235s → ×1.2 ≈ 282s
//   A2：3 case × (settled 600s + rename 45s + spawn) ≈ 1950s（2026-08-15 单 case 超 300s
//       击穿旧上限两次，settled 随之调至 600s）→ 取 2100s
//   A3：3a+3c = 180+45+10.5+180+45 = 460.5s；3b 最坏 3 次尝试 × (180+180+45+10.5) = 1246.5s
//       → 合计 1707s → ×1.2 ≈ 2049s → 取 2100s
//   A4：阶段1（errEnd/settled 并行 120s + skip 45s）= 120s + 阶段2（180+120+45+10）= 355s
//       → 合计 520s → ×1.2 = 624s
//   A5：stopEnd/settled 并行 120s + LLM request 30s + 超时失败 45s = 195s → ×1.2 = 234s
//   A6：首轮 settled/llmReq/start 并行 180s + renamed 45s + 落盘 10s = 235s + 次轮
//       (settled 180s + skip 45s) = 225s → 合计 460s → ×1.2 = 552s → 取 600s
//   A7：主进程 settled/toolLog 并行 180s + 落盘 10s = 190s + 对照 settled 180s = 370s
//       → ×1.2 = 444s → 取 480s
// 清理兜底说明：各 run-aN 场景函数内部 try/finally 已负责 pi/fixture 清理；wrapper 超时
// ≥ 内部最坏和后 vitest 不会在场景自身清理前掐断，无需额外 afterEach（场景句柄不外泄，
// 全局注册表需改 harness 内部，成本与收益不成比例）。
describe("E2E 场景 A1-A7（真实 pi + 真实模型）", () => {
	it("A1 工具型首轮：round 末触发 + 两段输入证据链", async () => {
		toGate(await runA1());
	}, 300_000);

	it("A2 slug 标题风格：中文 / 英文 / 跟进型 ×3 prompt 标题守卫", async () => {
		toGate(await runA2());
	}, 2_100_000);

	it("A3 防覆盖手动命名：3a 静态 + 3b 竞态 + 3c 一次性语义", async () => {
		toGate(await runA3());
	}, 2_100_000);

	it("A4 error 轮不命名 + --session 续跑后下一成功轮命名", async () => {
		toGate(await runA4());
	}, 630_000);

	it("A5 超时兜底：hang provider 30s 超时不落库 + pi 存活", async () => {
		toGate(await runA5());
	}, 240_000);

	it("A6 first-prompt 模式：首条 assistant 前 LLM request 已发出 + 标题仅基于 prompt + 后续不改名", async () => {
		toGate(await runA6());
	}, 600_000);

	it("A7 agent-tool 模式：工具改名即时落库覆盖既有名 + first-stop 对照零 toolCall", async () => {
		toGate(await runA7());
	}, 480_000);
});
