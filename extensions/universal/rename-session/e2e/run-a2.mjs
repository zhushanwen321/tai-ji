#!/usr/bin/env node
/**
 * A2 场景：slug 标题风格 ×3 prompt。
 *
 * [保留真实 LLM 不 faux 化，2026-09-15 L2.5 翻轨登记] 本场景是全仓唯一真依赖模型
 * 智能的用例（标题生成质量抽查——faux 演员只会回放脚本，测不出风格遵从）。触发条件
 * （满足其一时人工跑）：rename prompt（llm.ts buildTitleMessages / systemPrompt）改动、
 * 默认模型切换、pi 版本 bump。正式登记归 e2e-map（阶段 3 收录）。
 *
 * 三个独立 session：中文任务 / 英文任务 / 跟进型模糊 prompt。每个标题做两层断言
 * （assertTitleGuards，风格层与防回归层显式分离）：
 * - 风格层（有判别力）：不以代词开头、不以 了/过/中 结尾、纯英文标题小写 kebab-case
 * - 防回归层（锚 cleanTitle 契约）：≤50 码点、无句尾标点
 *
 * english-kebab-case 是模型遵从问题（非 extension 逻辑缺陷）：失败时打印
 * KEBAB_NON_COMPLIANT + 实际标题，交人工按 spec 处置路径决定（脚本不自动重跑，
 * 见 wave 任务契约）；其余违例视为硬失败。
 *
 * 跑完把三个标题追加到 e2e/RESULTS.md（词组形态/语义相关/语言跟随三列留空待人工抽查——
 * 自动规则对中文词组 vs 句子无完备判别力，正式验收以人工为准）。
 */

import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	HarnessError,
	assert,
	assertLogTitleMatches,
	assertTitleGuards,
	runScenario,
	runStandalone,
	spawnPi,
} from "./harness.mjs";

const RESULTS_PATH = fileURLToPath(new URL("./RESULTS.md", import.meta.url));

const CASES = [
	{ label: "中文任务", tag: "a2-zh", prompt: "帮我写一个防抖函数并加单测" },
	{ label: "英文任务", tag: "a2-en", prompt: "Refactor the config loader to support env overrides" },
	// 跟进型：prompt 本身无上下文（「继续刚才的」），空 tmp cwd 会诱发模型长时间探索自造上下文
	// （2026-08-15 两次全量实测：跟进型 case 在空目录下跑满 600s settled 上限，模型延迟变慢时更甚）。
	// fixture 目录给一个 notes.md 让「刚才的讨论」有最小锚点，模型快速收敛——跟进语义不变
	// （首条 prompt 仍是模糊跟进型），只是消除无谓探索。
	{
		label: "跟进型",
		tag: "a2-follow",
		prompt: "继续刚才的，改成支持 leading 选项",
		fixture: "notes.md",
		fixtureContent:
			"# 工作笔记\n\n正在实现 debounce 工具函数（debounce.ts），当前版本只有 trailing 触发。\n\n下一步：增加 leading 选项（首次调用立即执行）。\n",
	},
];

/** 跑单个 session，返回 { label, prompt, title }。标题以 JSONL session_info 为 SSOT，日志标题交叉校验。 */
async function runOneCase(c, log) {
	// 跟进型 case 用带 fixture 的独立 cwd（见 CASES 注释），其余用默认 tmp cwd
	let cwd;
	if (c.fixture) {
		cwd = mkdtempSync(join(tmpdir(), `rename-e2e-${c.tag}-cwd.`));
		writeFileSync(join(cwd, c.fixture), c.fixtureContent, "utf-8");
	}
	let pi = null;
	try {
		pi = await spawnPi({ tag: c.tag, cwd });
		// 600s 上限：重构/编码类 prompt 的工具循环较长（空 tmp cwd 下模型会探索后作答），
		// 仍有界（真挂死按 timeout 分类失败）。2026-08-15 实测模型延迟系统性变慢（前日三 case
		// 共 192s，当日单 case 超 300s 旧上限两次击穿——英文与跟进型各一次），按前日最坏值 3 倍上调
		const settledP = pi.rpc.waitAgentSettled(600_000);
		await pi.rpc.prompt(c.prompt);
		await settledP;
		// 显式等 renamed to（多 iteration 工具型 prompt 会先产生 skip: stopReason=toolUse 日志）
		const renameRes = await pi.rpc.waitForSessionLog('renamed to "', { timeoutMs: 45_000 });
		// 轮询等落盘（pi append→flush 有延迟，固定 sleep 慢日不够）
		const info = await pi.waitSessionInfoEntry(10_000);
		const title = info?.name ?? null;
		assert(typeof title === "string" && title.length > 0, "session_info.name 为空");
		assertLogTitleMatches(renameRes.message, title);
		log(`[${c.label}] 标题: ${title}`);
		return { label: c.label, prompt: c.prompt, title };
	} finally {
		pi?.cleanup();
		// 跟进型 fixture cwd 独立于 pi tmpDir，pi.cleanup() 不覆盖它——不单独清理则每次 run
		// 泄漏一个系统 tmp 目录；E2E_KEEP_TMP=1 时保留现场（对齐 harness cleanup 约定）
		if (cwd) {
			if (process.env.E2E_KEEP_TMP === "1") {
				console.warn(`[a2] E2E_KEEP_TMP=1，保留现场: ${cwd}`);
			} else {
				rmSync(cwd, { recursive: true, force: true });
			}
		}
	}
}

/** 追加一次 run 的三行记录到 RESULTS.md（文件不存在时先写表头）。 */
function appendResults(records) {
	const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
	const rows = records.map((r) => `| ${r.label} | ${r.prompt} | ${r.title} |  |  |  |`).join("\n");
	const section = `\n## ${stamp} run\n\n| 场景 | prompt | 实际标题 | 词组形态 | 语义相关 | 语言跟随 |\n|---|---|---|---|---|---|\n${rows}\n`;
	if (!existsSync(RESULTS_PATH)) {
		appendFileSync(
			RESULTS_PATH,
			`# rename-session E2E A2 人工抽查记录\n\n` +
				`本文件由 \`node e2e/run-a2.mjs\` 自动追加标题记录；「词组形态 / 语义相关 / 语言跟随」三列为人工抽查项（自动规则对中文词组 vs 句子无完备判别力，正式验收以人工为准，见 e2e/README.md A2 说明）。\n` +
				section,
			"utf8",
		);
		return;
	}
	appendFileSync(RESULTS_PATH, section, "utf8");
}

export async function runA2() {
	/** kebab 不合规记录（不翻 exit code，但必须在汇总中如实呈现） */
	let kebabNonCompliant = null;
	const result = await runScenario("A2", async (log) => {
		const records = [];
		for (const c of CASES) {
			const record = await runOneCase(c, log);
			records.push(record);

			const guards = assertTitleGuards(record.title);
			const kebabViol = guards.violations.find((v) => v.rule === "english-kebab-case");
			const hardViol = guards.violations.filter((v) => v.rule !== "english-kebab-case");
			if (kebabViol) {
				kebabNonCompliant = { label: c.label, title: record.title, violation: kebabViol.message };
				// 显式标记（人工按 spec 处置路径决定：prompt 微调重跑一次 → cleanTitle 硬转换预案，不第三轮）
				log(`KEBAB_NON_COMPLIANT [${c.label}] 实际标题: "${record.title}"`);
			}
			if (hardViol.length > 0) {
				throw new HarnessError(
					"assertion",
					`[${c.label}] 标题 "${record.title}" 断言失败:\n${hardViol.map((v) => `  [${v.layer}/${v.rule}] ${v.message}`).join("\n")}`,
				);
			}
		}
		appendResults(records);
		log(`已追加 ${records.length} 行标题记录到 e2e/RESULTS.md（人工抽查三列待填）`);
	});
	return { ...result, kebabNonCompliant };
}

// ── 独立执行入口（node e2e/run-a2.mjs）──
runStandalone(import.meta.url, runA2);
