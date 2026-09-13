// bench/cold-scan.bench.ts
//
// [perf L-1] sessions-index.json 冷扫描性能验收 bench（设计文档 §4.1 的可复现测量脚本，
// 上游 .xyz-harness/2026-08-15-subagent-workflow-perf/sessions-index-design.md）。
//
// 两种模式（先 cp 真实目录副本，只在副本上跑，不污染原目录）：
//
//   ENC="--Users-zhushanwen-Code-xyz-agent-workspace-feat-optimize-ui--"  # 任一真实 <enc> 段
//   cp -R ~/.pi/agent/subagents/$ENC /tmp/bench-enc/
//
//   # 1) 基线（无索引全量探测）：每轮 rm 索引后计时——否则轮 2-5 命中上一轮落盘的
//   #    索引走快速路径，中位数会被测成 ~0.3s（与基线自相矛盾）
//   npx tsx bench/cold-scan.bench.ts /tmp/bench-enc/$ENC/sessions --rounds 5 --baseline
//   #    轮 1 输出（真全量探测）持久化为 ground truth（gt 文件路径见运行输出）
//
//   # 2) 冷启动（索引命中）：中位数断言 <=300ms
//   npx tsx bench/cold-scan.bench.ts /tmp/bench-enc/$ENC/sessions --rounds 5
//
//   rm -rf /tmp/bench-enc   # 跑完清理副本
//
// 断言（任一失败 exit 1，错误信息含下一步动作）：
//   A1 每轮输出五元组 (id,agent,task,rootSessionId,status) 与 ground truth 完全一致。
//      对比基准 = 无索引全量探测的输出（--baseline 轮 1 或本进程内的全探扫描），
//      不是索引路径的自比
//   A2 冷启动模式中位数 <= 300ms（基线模式只报告不设阈值）
//   A3 索引落 <enc>/sessions-index.json（sessionsDir 兄弟位置）；sessionsDir 内 readdir
//      相对脚本启动时的快照无新增文件
//   A4 chmod 000 零读取轮（单独成轮，不参与 A1 等价对比——无索引冷扫对不可读文件的
//      行为是记录消失，索引命中是保留，属良性差异方向）：jsonl 全部去读权限后新实例
//      首扫仍返回全部记录（id 集与 ground truth 一致）；退化回读则记录消失。
//      win32 的 chmod 000 仅映射 read-only、root 无视 000，断言会退化为恒真——跳过
//      （与 src/__tests__/record-store-index.test.ts 的 chmodProbeIt 同款守卫）
//
// gt 文件按 sessionsDir 绝对路径哈希存 os.tmpdir()（跨两次调用共享 ground truth）；
// 目录内容变化后需先重跑 --baseline 刷新（gt 记录了来源 sessionsDir，不匹配即报错）。
// 不进 vitest（vitest.config.ts include 仅 src/**/__tests__/**/*.test.ts）、不进 CI。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

import { RecordStore } from "@zhushanwen/subagent-core";
import { INDEX_FILENAME } from "@zhushanwen/subagent-core/execution/persistence/sessions-index.ts";
import type { SubagentRecord } from "@zhushanwen/subagent-core";
import { toErrorMessage } from "@zhushanwen/pi-ext-guards";

/** 冷启动预算（设计目标 1：2.7s → ≤300ms）。 */
const COLD_SCAN_BUDGET_MS = 300;
/** 等待 fire-and-forget 索引落盘的上限（fsync 链最坏情况）。 */
const SETTLE_TIMEOUT_MS = 15_000;
/** 落盘等待的观察窗间隔与轮询上限（deadline 之上再加一道循环保险）。 */
const SETTLE_POLL_INTERVAL_MS = 150;
const SETTLE_MAX_POLLS = 10_000;
/** argv 中脚本参数起始下标（node + 脚本路径之后）。 */
const ARGV_ARGS_OFFSET = 2;
/** 中位数算法的除数/奇偶模。 */
const MEDIAN_HALF = 2;
/** 差异预览截断长度（防超长 task 文本刷屏）。 */
const DIFF_PREVIEW_CHARS = 160;
/** FNV-1a 32 位素数。 */
const FNV_PRIME = 0x01000193;
/** 十六进制基数（哈希后缀文件名）。 */
const HEX_RADIX = 16;
/** gt 文件 JSON 缩进。 */
const GT_JSON_INDENT = 2;
/** 权限位掩码（chmod 000 轮还原 mode）。 */
const PERM_MODE_MASK = 0o777;
const DEFAULT_ROUNDS = 5;
const DEFAULT_LIMIT = 2000;

// ============================================================
// CLI（手写解析，不引新依赖）
// ============================================================

interface ParsedArgs {
	sessionsDir: string;
	rounds: number;
	limit: number;
	baseline: boolean;
}

const USAGE = `用法: npx tsx bench/cold-scan.bench.ts <sessionsDir> [--rounds N] [--limit N] [--baseline]

  <sessionsDir>  真实 sessions 目录的【副本】路径（如 /tmp/bench-enc/<enc>/sessions）
  --rounds N     计时轮数（默认 ${DEFAULT_ROUNDS}，中位数取中间值）
  --limit N      collectRecords limit（默认 ${DEFAULT_LIMIT}）
  --baseline     无索引基线模式：每轮 rm 索引后计时；轮 1 输出写为 ground truth`;

/** 解析 --rounds/--limit 的正整数值（i 为 flag 下标，值位于其后；失败文案含收到的原值）。 */
function parsePositiveIntFlag(
	argv: readonly string[],
	i: number,
	flag: string,
): { ok: true; value: number } | { ok: false; error: string } {
	const raw = i + 1 < argv.length ? argv[i + 1] : undefined;
	const n = raw !== undefined ? Number(raw) : NaN;
	if (!Number.isInteger(n) || n <= 0) {
		return { ok: false, error: `${flag} 需要正整数参数（收到 "${raw ?? ""}"）\n${USAGE}` };
	}
	return { ok: true, value: n };
}

function parseArgs(argv: readonly string[]): { ok: true; value: ParsedArgs } | { ok: false; error: string } {
	let sessionsDir: string | undefined;
	let rounds = DEFAULT_ROUNDS;
	let limit = DEFAULT_LIMIT;
	let baseline = false;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--baseline") {
			baseline = true;
		} else if (a === "--rounds" || a === "--limit") {
			const parsed = parsePositiveIntFlag(argv, i, a);
			if (!parsed.ok) return parsed;
			if (a === "--rounds") rounds = parsed.value;
			else limit = parsed.value;
			i++;
		} else if (a === "--help" || a === "-h") {
			return { ok: false, error: USAGE };
		} else if (a.startsWith("--")) {
			return { ok: false, error: `未知参数 ${a}\n${USAGE}` };
		} else if (sessionsDir === undefined) {
			sessionsDir = a;
		} else {
			return { ok: false, error: `多余的位置参数 ${a}（只需 sessionsDir）\n${USAGE}` };
		}
	}
	if (sessionsDir === undefined) {
		return { ok: false, error: `缺少位置参数 sessionsDir\n${USAGE}` };
	}
	return { ok: true, value: { sessionsDir, rounds, limit, baseline } };
}

// ============================================================
// 共享工具
// ============================================================

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 五元组投影：断言 A1/A4 的比较形态（顺序敏感——排序由 RecordStore 决定，确定性输入下稳定）。 */
function projectRecords(records: readonly SubagentRecord[]): string[] {
	return records.map((r) => [r.id, r.agent, r.task, r.rootSessionId ?? "", r.status].join("\u0001"));
}

function medianOf(times: readonly number[]): number {
	const sorted = [...times].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / MEDIAN_HALF);
	return sorted.length % MEDIAN_HALF === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / MEDIAN_HALF;
}

function fmtMs(ms: number): string {
	return `${ms.toFixed(1)}ms`;
}

/** 逐行比较（不用 join 后比较：task 文本自身可能含换行等任意字符）。 */
function sameRows(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

/** 首个差异定位（错误信息可操作：指到具体行与值）。 */
function firstDiff(actual: readonly string[], expected: readonly string[]): string {
	const n = Math.min(actual.length, expected.length);
	for (let i = 0; i < n; i++) {
			if (actual[i] !== expected[i]) {
				return `第 ${i} 条不一致：实际 "${actual[i]!.slice(0, DIFF_PREVIEW_CHARS)}" vs 基准 "${expected[i]!.slice(0, DIFF_PREVIEW_CHARS)}"`;
			}
	}
	return `条数不一致：实际 ${actual.length} vs 基准 ${expected.length}`;
}

/** FNV-1a 32 位（gt 文件名后缀；仅用于区分不同 sessionsDir，无密码学要求）。 */
function fnv1a(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, FNV_PRIME);
	}
	return (h >>> 0).toString(HEX_RADIX);
}

/** <enc> 段内属于本索引机制的残留 tmp 文件（sessions-index.json.tmp.<pid>.<seq>）。 */
function listIndexTmp(encDir: string): string[] {
	try {
		return fs.readdirSync(encDir).filter((f) => f.startsWith(`${INDEX_FILENAME}.tmp.`));
	} catch {
		return []; // readdir 失败（encDir 不可读）在脚本开头的目录校验已拦截，这里不应到达
	}
}

function rmIndexArtifacts(encDir: string): void {
	const indexPath = path.join(encDir, INDEX_FILENAME);
	if (fs.existsSync(indexPath)) fs.rmSync(indexPath, { force: true });
	for (const tmp of listIndexTmp(encDir)) {
		fs.rmSync(path.join(encDir, tmp), { force: true });
	}
}

/**
 * 等待 fire-and-forget 索引落盘完成：索引存在且连续两个观察窗（150ms）无 tmp 残留。
 * RecordStore 的写决策在 collectRecords 同步段，扫描返回后只可能有已 dispatch 的写。
 */
async function waitIndexSettle(encDir: string, timeoutMs: number): Promise<void> {
	const stable = (): boolean => fs.existsSync(path.join(encDir, INDEX_FILENAME)) && listIndexTmp(encDir).length === 0;
	const deadline = Date.now() + timeoutMs;
	for (let i = 0; i < SETTLE_MAX_POLLS; i++) {
		if (Date.now() > deadline) {
			throw new Error(
				`索引落盘等待超时（${timeoutMs}ms）：${path.join(encDir, INDEX_FILENAME)} 未出现。` +
					`检查目录可写性；PI_EXT_DEBUG=1 重跑可在 ~/.pi/agent/logs/ 看扩展写入失败日志`,
			);
		}
		const s1 = stable();
		await sleep(SETTLE_POLL_INTERVAL_MS);
		if (s1 && stable()) return;
	}
	throw new Error("waitIndexSettle: unreachable（deadline 已兜底）");
}

/** gt 文件（跨调用共享 ground truth）。 */
interface GtFile {
	sessionsDir: string;
	recordCount: number;
	fiveTuple: string[];
}

function gtFilePath(sessionsDir: string): string {
	return path.join(os.tmpdir(), `subagent-workflow-cold-scan-gt-${fnv1a(path.resolve(sessionsDir))}.json`);
}

function hasNumberVersion(v: unknown): v is { version: unknown } {
	return typeof v === "object" && v !== null && "version" in v;
}

function readGtFile(p: string, sessionsDir: string): GtFile | undefined {
	let raw: string;
	try {
		raw = fs.readFileSync(p, "utf-8");
	} catch {
		return undefined; // 无 gt 文件 → 调用方走全量探测生成
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined; // 损坏视为不存在，重建（gt 是 bench 派生产物，无恢复价值）
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	if (!("sessionsDir" in parsed) || !("fiveTuple" in parsed)) return undefined;
	if (typeof parsed.sessionsDir !== "string" || !Array.isArray(parsed.fiveTuple)) return undefined;
	if (parsed.sessionsDir !== sessionsDir) {
		throw new Error(
			`gt 文件 ${p} 属于其他目录（${parsed.sessionsDir}）。目录内容变化后请先重跑 --baseline 刷新 gt`,
		);
	}
	const fiveTuple: string[] = [];
	for (const row of parsed.fiveTuple) {
		if (typeof row !== "string") return undefined;
		fiveTuple.push(row);
	}
	return { sessionsDir, recordCount: fiveTuple.length, fiveTuple };
}

function writeGtFile(p: string, sessionsDir: string, fiveTuple: readonly string[]): void {
	const content = JSON.stringify({ version: 1, sessionsDir, fiveTuple }, null, GT_JSON_INDENT);
	fs.writeFileSync(p, content, "utf-8");
}

/** 单轮扫描：新 RecordStore（模拟新进程冷启动）→ 计时 collectRecords → dispose。 */
interface ScanResult {
	ms: number;
	fiveTuple: string[];
	ids: string[];
}

function runColdScan(sessionsDir: string, limit: number): ScanResult {
	const store = new RecordStore(sessionsDir);
	try {
		const t0 = performance.now();
		const records = store.collectRecords(limit, "all");
		const t1 = performance.now();
		return {
			ms: t1 - t0,
			fiveTuple: projectRecords(records),
			ids: records.map((r) => r.id),
		};
	} finally {
		store.dispose();
	}
}

// ============================================================
// 主流程
// ============================================================

const runtimeErrors: string[] = [];
process.on("uncaughtException", (err: Error) => {
	runtimeErrors.push(`uncaughtException: ${err.message}`);
});
process.on("unhandledRejection", (reason: unknown) => {
	runtimeErrors.push(`unhandledRejection: ${String(reason)}`);
});

/** bench 运行上下文（argv 解析与目录校验的派生结果，helper 间显式传递）。 */
interface BenchContext {
	sessionsDir: string;
	resolvedSessionsDir: string;
	encDir: string;
	indexPath: string;
	rounds: number;
	limit: number;
	jsonlCount: number;
}

/** 真实 pi subagents 数据目录（原目录防护与文案恢复动作共用；从 homedir 动态推导）。 */
function realSubagentsDirPath(): string {
	return path.join(os.homedir(), ".pi", "agent", "subagents");
}

/** 目录校验三连（fail fast，错误可操作）。返回错误文案；通过时附带 *.jsonl 数。 */
function checkSessionsDir(
	sessionsDir: string,
	resolvedSessionsDir: string,
): { ok: true; jsonlCount: number } | { ok: false; error: string } {
	if (!fs.existsSync(sessionsDir) || !fs.statSync(sessionsDir).isDirectory()) {
		return {
			ok: false,
			error: `sessionsDir 不是目录: ${sessionsDir}\n先复制真实 <enc> 段副本：cp -R ~/.pi/agent/subagents/<enc> /tmp/bench-enc/\n`,
		};
	}
	// 原目录防护：真实 pi subagents 数据目录禁止跑 bench（本 bench 会 chmod 000 jsonl、
	// rm/重写索引，都会触碰真实 session 数据），必须先复制副本。路径从 homedir 动态推导
	const realSubagentsDir = realSubagentsDirPath();
	if (resolvedSessionsDir === realSubagentsDir || resolvedSessionsDir.startsWith(`${realSubagentsDir}${path.sep}`)) {
		return {
			ok: false,
			error:
				`拒绝在真实数据目录运行 bench: ${resolvedSessionsDir}\n` +
				`bench 会 chmod jsonl / rm 索引，污染真实 session 数据；请先复制副本：cp -R ${realSubagentsDir}/<enc> /tmp/bench-enc/\n`,
		};
	}
	const jsonlCount = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl")).length;
	if (jsonlCount === 0) {
		return { ok: false, error: `sessionsDir 内没有 *.jsonl: ${sessionsDir}（应指向 <enc>/sessions）\n` };
	}
	return { ok: true, jsonlCount };
}

/** 基线模式：每轮 rm 索引后计时，轮 1 输出 = ground truth。返回 false 表示断言失败（已写 stderr）。 */
async function runBaselineMode(ctx: BenchContext): Promise<boolean> {
	const { sessionsDir, resolvedSessionsDir, encDir, rounds, limit } = ctx;
	const times: number[] = [];
	let gt: string[] | undefined;
	for (let i = 0; i < rounds; i++) {
		rmIndexArtifacts(encDir); // 上一轮 settle 后的写在此清除，保证本轮真冷启动
		const result = runColdScan(sessionsDir, limit);
		times.push(result.ms);
		if (i === 0) {
			gt = result.fiveTuple;
			// 判 0 恒真防护：空 ground truth 会让 A1 的 sameRows 与 A4 的 id 集对比都
			// 退化为「空集对空集」恒真，断言失去防护意义——直接拒绝
			if (gt.length === 0) {
				process.stderr.write(
					`ground truth 为空（0 条记录）：${resolvedSessionsDir} 的 jsonl 均无 subagent 记录，` +
					`A1/A4 判 0 恒真失去防护。请换一个含 jsonl 记录的段复制：cp -R ${realSubagentsDirPath()}/<enc> /tmp/bench-enc/\n`,
				);
				return false;
			}
			writeGtFile(gtFilePath(sessionsDir), resolvedSessionsDir, gt);
		} else if (!sameRows(result.fiveTuple, gt!)) {
			process.stderr.write(`A1 失败（基线轮 ${i + 1} 与轮 1 输出不一致）：${firstDiff(result.fiveTuple, gt!)}\n`);
			return false;
		}
		await waitIndexSettle(encDir, SETTLE_TIMEOUT_MS); // 等写完成再进下一轮（rm 才不会与在途写竞争）
		process.stdout.write(`  baseline 轮 ${i + 1}/${rounds}: ${fmtMs(result.ms)}（${result.fiveTuple.length} 条记录）\n`);
	}
	const med = medianOf(times);
	process.stdout.write(`[cold-scan bench] 模式=baseline 目录=${sessionsDir}\n`);
	process.stdout.write(`  jsonl=${ctx.jsonlCount} 轮数=${rounds} 中位数=${fmtMs(med)}（无阈值，仅报告）\n`);
	process.stdout.write(`  ground truth 已写入: ${gtFilePath(sessionsDir)}（${gt!.length} 条五元组）\n`);
	return true;
}

/** 冷启动模式：索引命中 + 中位数断言 <=300ms（A2）。返回 false 表示断言失败（已写 stderr）。 */
async function runIndexHitMode(ctx: BenchContext): Promise<boolean> {
	const { sessionsDir, resolvedSessionsDir, encDir, indexPath, rounds, limit } = ctx;
	const times: number[] = [];
	let gt: string[] | undefined;
	const gtLoaded = readGtFile(gtFilePath(sessionsDir), resolvedSessionsDir);
	if (gtLoaded !== undefined) {
		gt = gtLoaded.fiveTuple;
	} else {
		// 无 gt 文件（未先跑 --baseline）：本进程内做一次无索引全量探测生成——
		// 同样是「真全量探测的输出」，满足 A1 的对比基准要求
		rmIndexArtifacts(encDir);
		const gen = runColdScan(sessionsDir, limit);
		gt = gen.fiveTuple;
		writeGtFile(gtFilePath(sessionsDir), resolvedSessionsDir, gt);
		await waitIndexSettle(encDir, SETTLE_TIMEOUT_MS); // 全探扫描 dirty → 落盘索引（即下面计时轮的命中源）
		process.stdout.write(`  ground truth 由本次无索引全量探测生成（${fmtMs(gen.ms)}）并写入 ${gtFilePath(sessionsDir)}\n`);
	}
	// 判 0 恒真防护（与 baseline 分支同款）：空 gt 让 A1/A4 恒真——直接拒绝
	if (gt.length === 0) {
		process.stderr.write(
			`ground truth 为空（0 条记录）：${resolvedSessionsDir} 的 jsonl 均无 subagent 记录，` +
			`A1/A4 判 0 恒真失去防护。请换一个含 jsonl 记录的段复制后重跑 --baseline\n`,
		);
		return false;
	}
	if (!fs.existsSync(indexPath)) {
		// gt 来自早前 --baseline（其末轮写仍在磁盘上则不会进这里；被清过则热身一次）
		runColdScan(sessionsDir, limit);
		await waitIndexSettle(encDir, SETTLE_TIMEOUT_MS);
	}
	for (let i = 0; i < rounds; i++) {
		const result = runColdScan(sessionsDir, limit);
		times.push(result.ms);
		if (!sameRows(result.fiveTuple, gt)) {
			process.stderr.write(`A1 失败（冷启动轮 ${i + 1} 与 ground truth 不一致）：${firstDiff(result.fiveTuple, gt)}\n`);
			return false;
		}
		process.stdout.write(`  cold 轮 ${i + 1}/${rounds}: ${fmtMs(result.ms)}（${result.fiveTuple.length} 条记录）\n`);
	}
	const med = medianOf(times);
	if (med > COLD_SCAN_BUDGET_MS) {
		process.stderr.write(
			`A2 失败：冷启动中位数 ${fmtMs(med)} 超预算 ${COLD_SCAN_BUDGET_MS}ms。` +
				`排查：索引是否命中（${indexPath} 存在且可读）、文件数是否暴涨；用 --baseline 对照基线\n`,
		);
		return false;
	}
	const probeCompleted = runChmodProbeRound(ctx, gt);
	process.stdout.write(`[cold-scan bench] 模式=index-hit 目录=${sessionsDir}\n`);
	process.stdout.write(`  jsonl=${ctx.jsonlCount} 轮数=${rounds} 中位数=${fmtMs(medianOf(times))}（预算 <=${COLD_SCAN_BUDGET_MS}ms）\n`);
	return probeCompleted;
}

/** A4：chmod 000 零读取轮（单独成轮，不参与 A1 等价对比）。返回 false 表示断言失败。 */
function runChmodProbeRound(ctx: BenchContext, gt: readonly string[]): boolean {
	const { sessionsDir, limit } = ctx;
	const chmodProbeEffective = process.platform !== "win32" && process.getuid?.() !== 0;
	if (chmodProbeEffective) {
		const jsonlFiles = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
		const savedModes: { file: string; mode: number }[] = [];
		for (const f of jsonlFiles) {
			const p = path.join(sessionsDir, f);
			savedModes.push({ file: p, mode: fs.statSync(p).mode & PERM_MODE_MASK });
			fs.chmodSync(p, 0o000);
		}
		try {
			const probe = runColdScan(sessionsDir, limit);
			const gotIds = [...probe.ids].sort();
			const gtIds = [...gt].map((row) => row.split("\u0001")[0]!).sort();
			if (!sameRows(gotIds, gtIds)) {
				const gotCount = probe.ids.length;
				process.stderr.write(
					`A4 失败：chmod 000 后记录不完整（${gotCount}/${gt.length}）——索引命中路径退化为读文件内容。` +
						`查 record-store.ts scanFile 的索引命中分支\n`,
				);
				return false;
			}
			process.stdout.write(`  chmod000 零读取轮: PASS（${probe.ids.length} 条记录全部经索引返回）\n`);
		} finally {
			for (const { file, mode } of savedModes) {
				fs.chmodSync(file, mode); // 精确还原权限，副本不留下 bench 痕迹
			}
		}
	} else {
		process.stdout.write("  chmod000 零读取轮: SKIP（win32/root 下 chmod 000 探测退化为恒真）\n");
	}
	return true;
}

/** 终态判定：A3（索引兄弟位置 + 合法 JSON + version 字段 + sessionsDir 无新增）+ 运行期异常汇总 + PASS 行。 */
function verifyFinalState(ctx: BenchContext, sessionsSnapshot: readonly string[], baseline: boolean): boolean {
	const { sessionsDir, indexPath } = ctx;
	if (!fs.existsSync(indexPath)) {
		process.stderr.write(`A3 失败：索引未落在兄弟位置 ${indexPath}\n`);
		return false;
	}
	let idxParsed: unknown;
	try {
		idxParsed = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
	} catch (err) {
		// 损坏/不可读索引必须命中声明的 A3 文案（不 catch 会让异常冒泡到顶层 catch，声明的判定文案不可达）
		process.stderr.write(
			`A3 失败：索引不是合法 JSON 或不可读: ${indexPath}（${toErrorMessage(err)}）\n` +
			`建议动作：rm "${indexPath}" 后重跑（索引为派生缓存，首次扫描会自动重建）\n`,
		);
		return false;
	}
	if (!hasNumberVersion(idxParsed) || typeof idxParsed.version !== "number") {
		process.stderr.write(`A3 失败：索引缺 version 字段: ${indexPath}\n建议动作：rm "${indexPath}" 后重跑（索引为派生缓存，首次扫描会自动重建）\n`);
		return false;
	}
	const sessionsAfter = fs.readdirSync(sessionsDir).sort();
	if (sessionsAfter.join("\n") !== sessionsSnapshot.join("\n")) {
		const added = sessionsAfter.filter((f) => !sessionsSnapshot.includes(f));
		process.stderr.write(`A3 失败：sessionsDir 出现新增文件: ${added.join(", ")}\n`);
		return false;
	}
	if (runtimeErrors.length > 0) {
		process.stderr.write(`运行期异常 ${runtimeErrors.length} 条：\n${runtimeErrors.join("\n")}\n`);
		return false;
	}
	process.stdout.write(baseline ? "  断言 A1/A3: PASS\n" : "  断言 A1/A2/A3/A4: PASS\n");
	return true;
}

async function main(): Promise<number> {
	const parsedArgv = parseArgs(process.argv.slice(ARGV_ARGS_OFFSET));
	if (!parsedArgv.ok) {
		process.stderr.write(`${parsedArgv.error}\n`);
		return 1;
	}
	const { sessionsDir, rounds, limit, baseline } = parsedArgv.value;
	const resolvedSessionsDir = path.resolve(sessionsDir);
	const encDir = path.dirname(resolvedSessionsDir);
	const indexPath = path.join(encDir, INDEX_FILENAME);

	const dirCheck = checkSessionsDir(sessionsDir, resolvedSessionsDir);
	if (!dirCheck.ok) {
		process.stderr.write(dirCheck.error);
		return 1;
	}
	// A3 前半：sessionsDir 文件集快照（结束时对比无新增）
	const sessionsSnapshot = fs.readdirSync(sessionsDir).sort();
	const ctx: BenchContext = {
		sessionsDir,
		resolvedSessionsDir,
		encDir,
		indexPath,
		rounds,
		limit,
		jsonlCount: dirCheck.jsonlCount,
	};
	const modeCompleted = baseline ? await runBaselineMode(ctx) : await runIndexHitMode(ctx);
	if (!modeCompleted) return 1;
	return verifyFinalState(ctx, sessionsSnapshot, baseline) ? 0 : 1;
}

main().then(
	(code: number) => {
		process.exitCode = code;
	},
	(err: unknown) => {
		process.stderr.write(`bench 异常退出: ${err instanceof Error ? err.stack : String(err)}\n`);
		process.exitCode = 1;
	},
);
