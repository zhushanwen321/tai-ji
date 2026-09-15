/**
 * rename-session E2E harness（T1）。
 *
 * 职责：
 * - spawnPi：隔离环境起真实 pi（RPC mode + rename-session extension），tmp 初始化
 *   （auth 迁移 / settings.json / auto-rename flag / 可选 models.json 与 ext-config 覆盖）
 * - faux LLM 轨（L2.5 翻轨，2026-09-15）：opts.faux 提供即切换凭证无关装配——
 *   settings/models 预置 faux provider（defaultProvider=faux 过 pi 模型解析）+
 *   --extension 注入 runtime fixtures 的 faux-llm-ext.ts + TAIJI_FAUX_SCRIPT 响应脚本。
 *   主对话 turn 与 rename LLM 调用（llm-shared completeSimple）共享同一 faux 队列
 *   （faux-llm-ext 双注册，见该文件头注释），脚本步骤按全局到达序排布。
 *   faux 模式跳过 auth 迁移（faux auth 恒无凭据）；A2（标题质量抽查）与 A5
 *   （stub server 超时）保留原装配不经 faux。
 * - 交错时间轴：stdout + stderr 两流 tee 到同一 timeline.ndjson，每行 {t, stream, line}
 *   （同步追加写，保到达序；pi 自身 stderr 输出（崩溃堆栈等）仍可在此排查）
 * - RPC client：stdin JSONL 写命令、按 id 关联响应、waitFor(eventType)、waitForSessionLog(pattern)、
 *   setSessionName / getState / prompt helper
 * - 断言纯函数（场景脚本与 harness.test.mjs 单测共用）：
 *   rebuildPreview / parseLogMessages / extractRenameLogEntries / extractLastStopAssistant /
 *   firstAssistantStartT / lastStopAssistantEndT / countToolCalls / countLlmRequestLogs /
 *   countSessionInfoEntries / assertTitleGuards / classifyFailure
 * - 清理：按 PID kill + tmp 目录删除（E2E_KEEP_TMP=1 保留现场）
 *
 * 探针结论依据见 e2e/README.md（P0）：RPC 严格 JSONL（手写 LF splitter，readline 不合规）；
 * turn_end 原始事件不带 turnIndex（断言 turnIndex 走 session JSONL 的 rename-session:log entry）。
 * rename 扩展日志走 extension-logger 的 appendEntry 通道（session custom entry），不写
 * pi 进程 stderr——等待扩展日志一律用 waitForSessionLog，不用 stderr。
 */

import { spawn } from "node:child_process";
import {
	appendFileSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import net from "node:net";

// ──────────────────────── 常量 ────────────────────────

/** 测试模型（项目规范：禁 kimi；A1-A7 主对话模型）。 */
export const E2E_MODEL = "xiaomi-token-plan-cn/mimo-v2.5-pro";

const E2E_DIR = fileURLToPath(new URL(".", import.meta.url));
/** 本 extension 目录（--extension 参数目标）。 */
const EXT_DIR = join(E2E_DIR, "..");
/** 仓库根（node_modules 内 pi cli 与各场景 cwd 用）。e2e 位于 <root>/extensions/universal/<pkg>/e2e/，上溯 3 层（包移入 universal/ 分组后多一层目录）。 */
const REPO_ROOT = join(EXT_DIR, "..", "..", "..");

/** pi cli 真身（node_modules/.bin/pi 是指向它的 symlink；直接 require 真身避开 shebang/权限问题）。 */
const PI_CLI = join(REPO_ROOT, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");

/** faux provider 注册 extension（runtime equivalence 套件同一 SSOT 文件，双注册见其文件头）。 */
const FAUX_LLM_EXT = join(
	REPO_ROOT, "packages", "runtime", "src", "__tests__", "fixtures", "faux-llm-ext.ts",
);

/** faux 轨模型（faux 装配的 --model）。 */
export const FAUX_MODEL = "faux/faux-1";

/** rename LLM 超时（固定 30s，与 llm.ts RENAME_TIMEOUT_MS 同值）+ 余量，waitForSessionLog 等 rename 结果日志的默认上限。 */
const RENAME_SETTLE_TIMEOUT_MS = 45_000;

// ──────────────────────── 错误与失败分类 ────────────────────────

/**
 * E2E harness 错误。kind 细分（classifyFailure 归并到四分类）：
 * assertion / timeout / pi-crash / api-error / rpc（RPC success:false，归并规则见 classifyFailure）
 */
export class HarnessError extends Error {
	/** @param {"assertion"|"timeout"|"pi-crash"|"api-error"|"rpc"} kind */
	constructor(kind, message, detail = undefined) {
		super(message);
		this.name = "HarnessError";
		this.kind = kind;
		if (detail !== undefined) this.detail = detail;
	}
}

/** HarnessError kind 归并（rpc 归并规则：pi 进程已死 = 协议层无法继续 → crash，否则按场景断言级）。 */
function classifyHarnessError(err) {
	if (err.kind === "rpc") {
		// RPC success:false：pi 进程已死归 crash（协议层无法继续），否则按场景断言级问题处理
		return err.detail?.piAlive === false ? "pi-crash" : "assertion";
	}
	return err.kind;
}

/** 超时族特征：错误类型名 / abort / ETIMEDOUT / message 含 timeout 字样。 */
function isTimeoutFailure(err, name, msg) {
	return name === "TimeoutError" || name === "AbortError" || err?.code === "ETIMEDOUT" || /timeout|timed out/i.test(msg);
}

/** LLM API 层失败特征（连接错误 / HTTP 4xx5xx / key 无效）。 */
function isApiFailure(msg) {
	if (
		/connection error|econnrefused|fetch failed|enotfound|econnreset|socket hang up|api key|unauthorized|forbidden|rate limit|\b(401|403|429|5\d\d)\b/i.test(
			msg,
		)
	) {
		return true;
	}
	return false;
}

/** 非 HarnessError 的裸错误按特征归四分类（无法识别的兜底 assertion，避免吞掉不可归类的失败）。 */
function classifyBareError(err) {
	const name = err?.name ?? "";
	const msg = String(err?.message ?? "");
	if (name === "AssertionError" || name === "HarnessAssertionError") return "assertion";
	if (isTimeoutFailure(err, name, msg)) return "timeout";
	if (isApiFailure(msg)) return "api-error";
	// 无法识别的裸错误按断言级处理（场景逻辑问题），避免吞掉不可归类的失败
	return "assertion";
}

/**
 * 失败四分类（runner 汇总输出用）：
 * - assertion：断言失败 / 场景逻辑错误（默认兜底——场景脚本裸 throw 的 AssertionError 等）
 * - timeout：waitFor / 超时包装超时
 * - pi-crash：pi 进程意外退出
 * - api-error：LLM API 层失败（连接错误 / HTTP 4xx5xx / key 无效）
 */
export function classifyFailure(err) {
	if (err instanceof HarnessError) return classifyHarnessError(err);
	return classifyBareError(err);
}

// ──────────────────────── 断言纯函数 ────────────────────────

/** 场景通用 sleep（场景脚本共用，避免 5 处重复定义）。 */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 场景通用 assert：失败抛 assertion 分类的 HarnessError（classifyFailure 归类）。 */
export function assert(cond, message) {
	if (!cond) throw new HarnessError("assertion", message);
}

/**
 * 从 session JSONL 行数组取最后一条 session_info entry（name SSOT；坏行跳过）。
 * 各场景原先各自维护近似实现（a2/a4 取 lines、a3 包了 pi 读取），统一到此处。
 */
export function lastSessionInfoEntry(lines) {
	let last = null;
	for (const line of lines ?? []) {
		try {
			const entry = JSON.parse(line);
			if (entry?.type === "session_info") last = entry;
		} catch {
			// 坏行跳过
		}
	}
	return last;
}

/** 逐行 JSON.parse，坏行跳过（session JSONL 可能含中断残行）。 */
export function parseJsonlEntries(lines) {
	const entries = [];
	for (const line of lines ?? []) {
		try {
			entries.push(JSON.parse(line));
		} catch {
			// 坏行跳过
		}
	}
	return entries;
}

// previewText 同构常量（与 extensions/universal/rename-session/src/llm.ts 的 preview 截断契约同值，Unicode 码点单位）
const PREVIEW_MAX_CODE_POINTS = 300;
const PREVIEW_HEAD_CODE_POINTS = 200;
const PREVIEW_TAIL_CODE_POINTS = 100;

// rename 扩展日志 entry 的 customType（extension-logger appendEntry 通道，createLogger(extName) 的 extName 前缀）
export const RENAME_LOG_CUSTOM_TYPE = "rename-session:log";

/**
 * 从 session JSONL 行数组提取 rename-session 的日志 entry（extension-logger appendEntry 通道）。
 *
 * entry 形状（pi session-manager appendCustomEntry × extension-logger createLogger.warn/error）：
 *   { type: "custom", customType: "rename-session:log",
 *     data: { timestamp: <epoch ms>, level: "warn"|"error",
 *             message: "[rename-session] t=... <文案>", data?: unknown },
 *     id, parentId, timestamp: <ISO> }
 * （权威源：extensions/shared/extension-logger/src/index.ts + pi dist/core/session-manager.js）
 *
 * @param {string[]} lines session JSONL 行数组（坏行跳过）
 * @returns {Array<{t: number, level: string, message: string}>} 按文件行序（= append 时序）；
 *   t 优先取 data.timestamp（epoch ms，pi 内部时钟），缺失回落 entry.timestamp 解析
 */
export function extractRenameLogEntries(lines) {
	if (!Array.isArray(lines)) throw new TypeError("extractRenameLogEntries: expects string[]");
	const entries = [];
	for (const line of lines) {
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue; // 坏行跳过（session 文件按行独立）
		}
		if (entry?.type !== "custom" || entry?.customType !== RENAME_LOG_CUSTOM_TYPE) continue;
		const data = entry.data;
		if (typeof data?.message !== "string") continue; // 缺 message 的畸形 entry 不参与匹配
		let t = typeof data.timestamp === "number" ? data.timestamp : Date.parse(entry.timestamp);
		if (!Number.isFinite(t)) t = 0;
		entries.push({ t, level: typeof data.level === "string" ? data.level : "warn", message: data.message });
	}
	return entries;
}

/**
 * 与 llm.ts previewText 同构的预览重构（A1 内容匹配主判别器）：
 * ≤300 码点全文；>300 → head 200 码点 + 字面 `…` + tail 100 码点（Array.from 码点切分，
 * 代理对/emoji 不被劈开——与 llm.ts 行为一致即同构，单测锁定此行为）。
 */
export function rebuildPreview(text) {
	if (typeof text !== "string") throw new TypeError("rebuildPreview: text must be string");
	const chars = Array.from(text);
	if (chars.length <= PREVIEW_MAX_CODE_POINTS) return text;
	return (
		chars.slice(0, PREVIEW_HEAD_CODE_POINTS).join("") +
		"…" +
		chars.slice(-PREVIEW_TAIL_CODE_POINTS).join("")
	);
}

/** LLM request debug 日志行标记（llm.ts debugLog 文案）。 */
export const LLM_REQUEST_MARKER = "LLM request messages: ";

/**
 * 从 stderr 日志行解析 LLM request messages：`[rename-session] t=<ISO> LLM request messages: [{role,text}]`。
 * 非 LLM request 行 / JSON 损坏返回 null（场景脚本过滤用）。
 * @returns {Array<{role: string, text: string}> | null}
 */
export function parseLogMessages(line) {
	if (typeof line !== "string") return null;
	const idx = line.indexOf(LLM_REQUEST_MARKER);
	if (idx === -1) return null;
	const jsonPart = line.slice(idx + LLM_REQUEST_MARKER.length);
	// try 只包 JSON.parse：结构校验失败的 HarnessError 直接上抛，无需 catch 内 rethrow 舞步
	let parsed;
	try {
		parsed = JSON.parse(jsonPart);
	} catch {
		return null; // JSON 损坏
	}
	if (!Array.isArray(parsed)) return null;
	// 宽松校验：成员须形如 {role, text}（防御日志格式漂移时给出可读失败而非静默 undefined）
	return parsed.map((m) => {
		if (typeof m?.role !== "string" || typeof m?.text !== "string") {
			throw new HarnessError("assertion", `parseLogMessages: bad message entry ${JSON.stringify(m)}`);
		}
		return { role: m.role, text: m.text };
	});
}

/**
 * 从 session JSONL 行数组提取最后一条 stopReason==='stop' 的 assistant message 文本。
 * 与 llm.ts extractFinalText 同构：content 须为 blocks 数组，过滤 type==='text' 后 join(' ')。
 * 无匹配返回 null。
 * @param {string[]} jsonlLines
 * @returns {string | null}
 */
export function extractLastStopAssistant(jsonlLines) {
	if (!Array.isArray(jsonlLines)) throw new TypeError("extractLastStopAssistant: expects string[]");
	let last = null;
	for (const line of jsonlLines) {
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue; // 坏行跳过（session 文件按行独立，不因单行损坏整体失败）
		}
		if (entry?.type !== "message") continue;
		const msg = entry.message;
		if (msg?.role !== "assistant" || msg?.stopReason !== "stop") continue;
		// 与 extractFinalText 同构：非 blocks 数组 → 无文本
		if (!Array.isArray(msg.content)) {
			last = "";
			continue;
		}
		last = msg.content
			.filter((block) => typeof block === "object" && block !== null && block.type === "text")
			.map((block) => (typeof block.text === "string" ? block.text : ""))
			.join(" ");
	}
	return last;
}

/**
 * 从交错时间轴取首条 assistant message_start 事件的时刻（A6 first-prompt 触发时点断言，设计 rename-session-three-modes.md V2）。
 * timeline 条目 = createTimeline 的 {t, stream, line}：只认 stdout 流（stream === "out"）的
 * JSON 事件行（RPC 无过滤转发全部 session 事件），坏 JSON 行跳过。无匹配返回 null（调用方 assert）。
 * @param {Array<{t: number, stream: string, line: string}>} timeline
 * @returns {number | null}
 */
export function firstAssistantStartT(timeline) {
	if (!Array.isArray(timeline)) throw new TypeError("firstAssistantStartT: expects timeline entry array");
	for (const e of timeline) {
		if (e?.stream !== "out") continue;
		let ev;
		try {
			ev = JSON.parse(e.line);
		} catch {
			continue; // 坏行跳过（时间轴含非 JSON 行，仅入档排查）
		}
		if (ev?.type === "message_start" && ev?.message?.role === "assistant") return e.t;
	}
	return null;
}

/**
 * 从交错时间轴取最后一条 stopReason==="stop" 的 assistant message_end 事件时刻
 * （A6 完成序观察 / A7 立即落库断言；A1 流序判别内嵌同名逻辑的通用化版本）。
 * 无匹配返回 null。
 * @param {Array<{t: number, stream: string, line: string}>} timeline
 * @returns {number | null}
 */
export function lastStopAssistantEndT(timeline) {
	if (!Array.isArray(timeline)) throw new TypeError("lastStopAssistantEndT: expects timeline entry array");
	let last = null;
	for (const e of timeline) {
		if (e?.stream !== "out") continue;
		let ev;
		try {
			ev = JSON.parse(e.line);
		} catch {
			continue; // 坏行跳过
		}
		if (ev?.type === "message_end" && ev?.message?.role === "assistant" && ev?.message?.stopReason === "stop") {
			last = e.t;
		}
	}
	return last;
}

/**
 * 数 session JSONL 行数组中指定工具的 toolCall 次数（A7 agent-tool 场景，设计 rename-session-three-modes.md V3/V10 的
 * 确定性判据支撑：pi RPC 无工具清单查询命令，但「无工具 ⇒ 必无 toolCall」与 agent 行为无关）。
 * toolCall block 形态：assistant message content 数组成员 {type:"toolCall", name, arguments}；
 * toolResult message 与非数组 content 不计入。坏行跳过；lines 为 null/undefined（session
 * 文件尚未创建契约）按 0 计。
 * @param {string[] | null | undefined} lines session JSONL 行数组
 * @returns {number}
 */
/**
 * 单条 session entry 内指定工具的 toolCall block 计数（countToolCalls 内层提取，控制圈复杂度）。
 * 非 assistant message entry / content 非数组按 0 计。
 */
function countToolCallsInEntry(entry, toolName) {
	if (entry?.type !== "message" || entry.message?.role !== "assistant") return 0;
	if (!Array.isArray(entry.message.content)) return 0;
	let count = 0;
	for (const block of entry.message.content) {
		if (block?.type === "toolCall" && block.name === toolName) count++;
	}
	return count;
}

export function countToolCalls(lines, toolName) {
	if (typeof toolName !== "string") throw new TypeError("countToolCalls: toolName must be string");
	if (lines === null || lines === undefined) return 0;
	if (!Array.isArray(lines)) throw new TypeError("countToolCalls: expects string[]");
	let count = 0;
	for (const line of lines) {
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue; // 坏行跳过
		}
		count += countToolCallsInEntry(entry, toolName);
	}
	return count;
}

/**
 * session JSONL 行数组中 rename LLM request 内省日志条数（A6 ④「后续 round 不再改名」的
 * 无新调用断言；A3 3c 场景内同名本地实现的 harness 通用版）。lines 为 null 时按 0 计。
 * @param {string[] | null} lines
 * @returns {number}
 */
export function countLlmRequestLogs(lines) {
	return extractRenameLogEntries(lines ?? []).filter((e) => e.message.includes(LLM_REQUEST_MARKER)).length;
}

/**
 * session JSONL 行数组中 session_info entry 条数（A6 ④「无新 session_info」断言；A3 3c
 * 场景内同名本地实现的 harness 通用版）。lines 为 null 时按 0 计。
 * @param {string[] | null} lines
 * @returns {number}
 */
export function countSessionInfoEntries(lines) {
	return parseJsonlEntries(lines ?? []).filter((e) => e?.type === "session_info").length;
}

/** 英文 kebab-case：小写字母/数字 + 连字符分段。 */
const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** 英文代词开头（We/I/This 作为独立词开头，\b 保证不误伤 widget/ios 等前缀拼接词）。 */
const EN_PRONOUN_START_RE = /^(?:we|i|this)\b/i;
/** 中文代词/指示词开头。 */
const ZH_PRONOUN_START = ["我", "你", "它"];
/** 时态助词/未完态结尾（抓「修复了X」「进行中」类句子漏网形态）。 */
const BAD_ENDINGS = ["了", "过", "中"];
/** 句尾标点断言集 = cleanTitle 清洗集（。．.，,、;；!！?？：:）。 */
const TRAILING_PUNCT_RE = /[。．.，,、;；!！?？：:]$/;
/** cleanTitle 默认标题上限（Unicode 码点）。 */
const DEFAULT_MAX_TITLE_CODE_POINTS = 50;

/**
 * 标题代理断言（A2），两层显式分离：
 * - 风格层（有判别力，失败按 C3 处置：prompt 微调重跑 → 硬转换预案）：
 *   不以代词开头（我/你/它/We/I/This）、不以 了/过/中 结尾、纯英文标题须小写 kebab-case
 * - 防回归层（零风格判别力，仅锚 cleanTitle 契约）：≤50 码点、无句尾标点
 *
 * 纯求值不抛错，返回 {ok, violations: [{layer, rule, message}]}，场景脚本自行决定处置。
 */
export function assertTitleGuards(title, opts = {}) {
	const maxCodePoints = opts.maxCodePoints ?? DEFAULT_MAX_TITLE_CODE_POINTS;
	const violations = [];
	const push = (layer, rule, message) => violations.push({ layer, rule, message });

	if (typeof title !== "string" || title.length === 0) {
		push("regression", "non-empty", `title 为空或非字符串: ${JSON.stringify(title)}`);
		return { ok: false, violations };
	}

	// ── 风格层 ──
	if (ZH_PRONOUN_START.some((p) => title.startsWith(p)) || EN_PRONOUN_START_RE.test(title)) {
		push("style", "no-pronoun-start", `标题以代词开头: "${title}"`);
	}
	if (BAD_ENDINGS.some((e) => title.endsWith(e))) {
		push("style", "no-tense-ending", `标题以 了/过/中 结尾: "${title}"`);
	}
	// 纯 ASCII 视为英文标题，须 kebab-case（中文/混合标题跳过——中文词组形态人工抽查，见 design A2）
	if (/^[\x20-\x7E]+$/.test(title) && !KEBAB_RE.test(title)) {
		push("style", "english-kebab-case", `英文标题非小写 kebab-case: "${title}"`);
	}

	// ── 防回归层（锚 cleanTitle）──
	const codePoints = Array.from(title).length;
	if (codePoints > maxCodePoints) {
		push("regression", "max-length", `标题 ${codePoints} 码点 > 上限 ${maxCodePoints}: "${title}"`);
	}
	if (TRAILING_PUNCT_RE.test(title)) {
		push("regression", "no-trailing-punct", `标题含句尾标点: "${title}"`);
	}

	return { ok: violations.length === 0, violations };
}

// ──────────────────────── 交错时间轴 ────────────────────────

/**
 * 交错时间轴：stdout/stderr 每行带到达时刻与流标记追加写同一文件。
 * appendFileSync 同步写——两流 handler 同线程串行执行，文件行序 = 到达序（A1 流序断言前提）。
 */
function createTimeline(filePath) {
	const lines = [];
	return {
		/** @param {"out"|"err"} stream */
		push(stream, line) {
			const entry = { t: Date.now(), stream, line };
			lines.push(entry);
			appendFileSync(filePath, JSON.stringify(entry) + "\n");
		},
		/** 内存副本（进程存活期间的即时查询）。 */
		all() {
			return lines.slice();
		},
	};
}

/**
 * 手写 JSONL reader（rpc.md 明确 Node readline 不合规：会按 U+2028/U+2029 切行）。
 * LF 分隔、容忍 \r\n、末尾无换行的残余行在 end 时 flush。
 */
function attachJsonlReader(stream, onLine) {
	// 行级交付统一闭包：剥 \r、跳空行——主循环与 end flush 共用同一实现，避免两处近似复制各自漂移
	const emit = (line) => {
		if (line.endsWith("\r")) line = line.slice(0, -1);
		if (line.length > 0) onLine(line);
	};
	let buffer = "";
	stream.setEncoding("utf8");
	stream.on("data", (chunk) => {
		buffer += chunk;
		while (true) {
			const i = buffer.indexOf("\n");
			if (i === -1) break;
			emit(buffer.slice(0, i));
			buffer = buffer.slice(i + 1);
		}
	});
	stream.on("end", () => {
		// 末尾无换行的残余行在此 flush（空 buffer 由 emit 的空行检查自行跳过）
		emit(buffer);
		buffer = "";
	});
}

// ──────────────────────── A5 stub socket ────────────────────────

/**
 * hang provider stub：TCP accept 后不响应任何数据（A5 超时兜底场景）。
 * @returns {Promise<{port: number, close: () => void}>}
 */
export function startHangServer(host = "127.0.0.1") {
	return new Promise((resolve, reject) => {
		const sockets = new Set();
		const server = net.createServer((socket) => {
			sockets.add(socket);
			socket.on("data", () => {}); // 故意不响应
			socket.on("error", () => {});
			socket.on("close", () => sockets.delete(socket));
		});
		server.on("error", reject);
		server.listen(0, host, () => {
			resolve({
				port: server.address().port,
				close: () => {
					for (const s of sockets) s.destroy();
					server.close();
				},
			});
		});
	});
}

// ──────────────────────── spawnPi ────────────────────────

/**
 * tmp agent 目录初始化：
 * - 真实轨（faux 未提供）：auth.json 复制自 ~/.pi/agent/auth.json（不存在则要求 env 兜底并留警告）
 * - faux 轨：跳过 auth 迁移（凭证无关），settings/models 预置 faux provider
 * - settings.json：enabledModels + retry.enabled=false（消除 error 轮 auto-retry 退避）
 * - auto-rename-enabled flag 文件（extension 开关 live 覆盖源）
 * - 可选覆盖：modelsJson（A4 坏 provider / A5 stub provider）、renameConfig（A5 标题模型指向）
 */
function initAgentDir(agentDir, opts = {}) {
	mkdirSync(agentDir, { recursive: true });

	if (opts.faux) {
		// faux 轨：settings/models 预置 faux provider（defaultProvider=faux 供 --model
		// 解析 + pi 模型清单；与 e2e real 轨 launch-app-real.ts seedFauxDataDir 同款语义）
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify(
				{
					defaultProvider: "faux",
					defaultModel: FAUX_MODEL.split("/")[1],
					enabledModels: [FAUX_MODEL],
					retry: { enabled: false },
				},
				null,
				2,
			),
		);
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify(
				{
					providers: {
						faux: {
							name: "faux",
							api: "faux",
							apiKey: "not-needed",
							models: [
								{
									id: FAUX_MODEL.split("/")[1],
									name: "Faux 1",
									input: ["text"],
									contextWindow: 128000,
									maxTokens: 16384,
								},
							],
						},
					},
				},
				null,
				2,
			),
		);
		writeFileSync(join(agentDir, "auto-rename-enabled"), "", "utf-8");
		if (opts.renameConfig) {
			mkdirSync(join(agentDir, "config"), { recursive: true });
			writeFileSync(
				join(agentDir, "config", "rename-session-ext-config.json"),
				JSON.stringify(opts.renameConfig, null, 2),
			);
		}
		return agentDir;
	}

	const srcAuth = join(homedir(), ".pi/agent/auth.json");
	if (existsSync(srcAuth)) {
		copyFileSync(srcAuth, join(agentDir, "auth.json"));
	} else if (!process.env.XIAOMI_TOKEN_PLAN_CN_API_KEY) {
		// auth 与 env 双缺失才报错（探针 1 降级路径：env 注入）
		throw new HarnessError(
			"api-error",
			`auth 不可迁移：${srcAuth} 不存在且未设置 XIAOMI_TOKEN_PLAN_CN_API_KEY（恢复：先在常规 pi 环境完成 /login，或 export 该 env 后重跑）`,
		);
	}

	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify(
			{
				enabledModels: opts.enabledModels ?? [E2E_MODEL],
				retry: { enabled: false },
			},
			null,
			2,
		),
	);

	writeFileSync(join(agentDir, "auto-rename-enabled"), "", "utf-8");

	if (opts.modelsJson) {
		writeFileSync(join(agentDir, "models.json"), JSON.stringify(opts.modelsJson, null, 2));
	}
	if (opts.renameConfig) {
		mkdirSync(join(agentDir, "config"), { recursive: true });
		writeFileSync(
			join(agentDir, "config", "rename-session-ext-config.json"),
			JSON.stringify(opts.renameConfig, null, 2),
		);
	}
	return agentDir;
}

/**
 * 起真实 pi（RPC mode）+ rename-session extension。
 *
 * @param {object} [opts]
 * - tag：tmp 目录后缀（多场景并存区分）
 * - cwd：agent 工作目录（默认 tmp；A1 需要 ts 文件的目录时传仓库内路径）
 * - sessionFile：--session 续跑（A4 阶段 2）
 * - modelsJson / renameConfig / enabledModels：透传 initAgentDir
 * - faux：faux LLM 轨装配 { responses: Array<{thinking?,text?,toolCalls?,stopReason?,error?}>, tps?: number }
 *   ——提供即凭证无关（settings/models 预置 faux + --extension faux-llm-ext + env
 *   TAIJI_FAUX_SCRIPT/TAUJI_FAUX_TPS；模型恒 FAUX_MODEL，opts.model 被覆盖）
 * - piCli：覆盖 pi cli 路径（默认 repo node_modules 内真身）
 * - keepTmp：保留 tmp（默认读 E2E_KEEP_TMP）
 * @returns pi handle（见函数尾部注释）
 */
export async function spawnPi(opts = {}) {
	// 一次求值复用：原实现检查与 args 各求一遍，且报错固定打印默认路径——自定义 piCli 失败时误导恢复方向
	const piCli = opts.piCli ?? PI_CLI;
	if (!existsSync(piCli)) {
		throw new HarnessError(
			"pi-crash",
			`pi cli 不存在: ${piCli}（恢复：在仓库根跑 pnpm install 后重跑，或用 opts.piCli 指定路径）`,
		);
	}

	const keepTmp = opts.keepTmp ?? process.env.E2E_KEEP_TMP === "1";
	const tmpDir = mkdtempSync(join(tmpdir(), `rename-e2e-${opts.tag ?? "run"}.`));
	const agentDir = join(tmpDir, "agent");
	const sessionsDir = join(tmpDir, "sessions");
	try {
		mkdirSync(sessionsDir, { recursive: true });
		initAgentDir(agentDir, opts);
	} catch (err) {
		if (!keepTmp) rmSync(tmpDir, { recursive: true, force: true });
		throw err;
	}

	// faux 轨：响应脚本落 agentDir（pi 对该目录只读特定文件名，faux-responses.json
	// 不在读取面），env 注入后经 spawn 继承透传给 pi 子进程
	const fauxEnv = {};
	if (opts.faux) {
		const scriptPath = join(agentDir, "faux-responses.json");
		writeFileSync(scriptPath, JSON.stringify(opts.faux.responses));
		fauxEnv.TAIJI_FAUX_SCRIPT = scriptPath;
		if (opts.faux.tps && opts.faux.tps > 0) fauxEnv.TAIJI_FAUX_TPS = String(opts.faux.tps);
	}

	const timelinePath = join(tmpDir, "timeline.ndjson");
	const timeline = createTimeline(timelinePath);

	const args = [
		piCli,
		"--mode",
		"rpc",
		"--session-dir",
		sessionsDir,
		"--model",
		opts.faux ? FAUX_MODEL : opts.model ?? E2E_MODEL,
		"--approve",
		"--extension",
		join(EXT_DIR),
	];
	if (opts.faux) args.push("--extension", FAUX_LLM_EXT);
	if (opts.sessionFile) args.push("--session", opts.sessionFile);

	const proc = spawn(process.execPath, args, {
		cwd: opts.cwd ?? tmpDir,
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: agentDir,
			TAIJI_AGENT_DEBUG: "1",
			PI_SKIP_VERSION_CHECK: "1",
			...fauxEnv,
			...(opts.extraEnv ?? {}),
		},
		stdio: ["pipe", "pipe", "pipe"],
	});

	// ── RPC client 状态 ──
	let reqSeq = 0;
	const pending = new Map(); // id → {resolve, reject}
	const eventWaiters = []; // {match(ev), resolve, reject, timer}
	let piAlive = true;
	let exitInfo = null;

	const rejectPending = (err) => {
		for (const { reject } of pending.values()) reject(err);
		pending.clear();
		for (const w of eventWaiters) {
			clearTimeout(w.timer);
			w.reject(err);
		}
		eventWaiters.length = 0;
	};

	proc.on("exit", (code, signal) => {
		piAlive = false;
		exitInfo = { code, signal };
		rejectPending(
			new HarnessError("pi-crash", `pi 进程退出 code=${code} signal=${signal}`, { code, signal }),
		);
	});

	// stdout：JSON 行 = RPC 响应（有 id）或事件
	attachJsonlReader(proc.stdout, (line) => {
		timeline.push("out", line);
		let ev;
		try {
			ev = JSON.parse(line);
		} catch {
			return; // 非 JSON 行仅入时间轴（A1 负向断言可能用到）
		}
		if (ev?.type === "response" && typeof ev.id === "string" && pending.has(ev.id)) {
			const { resolve } = pending.get(ev.id);
			pending.delete(ev.id);
			resolve(ev);
			return;
		}
		for (let i = eventWaiters.length - 1; i >= 0; i--) {
			const w = eventWaiters[i];
			if (w.match(ev)) {
				clearTimeout(w.timer);
				eventWaiters.splice(i, 1);
				w.resolve(ev);
			}
		}
	});

	// stderr：tee 进时间轴（pi 自身输出，崩溃堆栈等排查用）。扩展 rename 日志不走此流
	//（extension-logger appendEntry 落 session JSONL），等待日志用 waitForSessionLog。
	attachJsonlReader(proc.stderr, (line) => {
		timeline.push("err", line);
	});

	/** 写一条 RPC 命令。 */
	const send = (cmd) => {
		if (!piAlive) {
			throw new HarnessError("pi-crash", `pi 已退出（${JSON.stringify(exitInfo)}），无法发送命令`);
		}
		proc.stdin.write(JSON.stringify(cmd) + "\n");
	};

	/** 发命令并等对应 id 的响应；success:false 拒绝（rpc kind，classifyFailure 归并）。 */
	const request = (cmd, timeoutMs = 30_000) => {
		const id = `req-${++reqSeq}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new HarnessError("timeout", `RPC 响应超时 ${timeoutMs}ms: ${cmd.type} (id=${id})`));
			}, timeoutMs);
			pending.set(id, {
				resolve: (resp) => {
					clearTimeout(timer);
					if (resp.success === false) {
						reject(new HarnessError("rpc", `RPC ${cmd.type} 失败: ${resp.error ?? "unknown"}`, { resp, piAlive }));
					} else {
						resolve(resp);
					}
				},
				reject: (err) => {
					clearTimeout(timer);
					reject(err);
				},
			});
			send({ ...cmd, id });
		});
	};

	/** 等待匹配的 stdout 事件（默认按 type；filter 可加谓词）。 */
	const waitFor = (type, { timeoutMs = 60_000, filter } = {}) =>
		new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				const i = eventWaiters.indexOf(w);
				if (i >= 0) eventWaiters.splice(i, 1);
				reject(new HarnessError("timeout", `waitFor(${type}) 超时 ${timeoutMs}ms`));
			}, timeoutMs);
			const w = {
				match: (ev) => ev?.type === type && (!filter || filter(ev)),
				resolve: (ev) => resolve(ev),
				reject,
				timer,
			};
			eventWaiters.push(w);
		});

	/** 等待 session JSONL 中出现匹配的 rename-session 日志 entry（extension-logger appendEntry 通道）。
	 *  pattern: string 子串或 RegExp，匹配 entry 的 message（`[rename-session] t=... <文案>`）。
	 *  轮询实现（appendEntry 是 pi 内部同步落盘，无需事件通知）；晚注册不丢早到的 entry
	 *  （每轮全量重读）。返回 { message, t }（t = data.timestamp，间隔计时用）。
	 *  pi 进程退出时按 pi-crash 拒绝（不等满 timeout，保分类正确）。 */
	const waitForSessionLog = (pattern, { timeoutMs = RENAME_SETTLE_TIMEOUT_MS } = {}) =>
		new Promise((resolve, reject) => {
			const match =
				typeof pattern === "string" ? (m) => m.includes(pattern) : (m) => pattern.test(m);
			const deadline = Date.now() + timeoutMs;
			const poll = async () => {
				if (!piAlive) {
					reject(
						new HarnessError(
							"pi-crash",
							`pi 进程退出（${JSON.stringify(exitInfo)}），waitForSessionLog(${pattern}) 中止`,
						),
					);
					return;
				}
				try {
					const lines = await readSessionLines();
					for (const entry of lines ? extractRenameLogEntries(lines) : []) {
						if (match(entry.message)) {
							resolve({ message: entry.message, t: entry.t });
							return;
						}
					}
				} catch (err) {
					reject(err);
					return;
				}
				if (Date.now() >= deadline) {
					reject(new HarnessError("timeout", `waitForSessionLog(${pattern}) 超时 ${timeoutMs}ms`));
					return;
				}
				setTimeout(poll, 250);
			};
			void poll();
		});

	// ── 高层 helper ──
	// 单参契约：调用方只传 message；旧签名第二参会展开进 RPC 命令体，把 timeoutMs 等控制字段泄漏给 pi
	const prompt = (message) => request({ type: "prompt", message });
	const setSessionName = (name) => request({ type: "set_session_name", name });
	const getState = () => request({ type: "get_state" });
	/** 等 round 完成（agent_settled；注意 error 轮也发 settled——成败要看 turn_end 的 stopReason）。 */
	const waitAgentSettled = (timeoutMs = 120_000) => waitFor("agent_settled", { timeoutMs });

	// ── 清理 ──
	let killed = false;
	const kill = () => {
		if (!killed && piAlive) {
			try {
				proc.kill("SIGKILL"); // 按 PID 精确终止（项目规范：禁止宽泛 pkill）
			} catch {}
		}
		killed = true;
	};
	const cleanup = () => {
		kill();
		if (!keepTmp) {
			try {
				rmSync(tmpDir, { recursive: true, force: true });
			} catch {}
		} else {
			console.warn(`[harness] E2E_KEEP_TMP=1，保留现场: ${tmpDir}`);
		}
	};

	/** session JSONL 文件路径（round 完成且已 flush 后有效；文件可能延迟出现，见项目规则 #6）。 */
	const sessionJsonlPath = async () => {
		const resp = await getState();
		return resp.data?.sessionFile ?? null;
	};
	/**
	 * 轮询等待最后一条 session_info 落盘（pi 的 append→flush 存在延迟——固定 sleep
	 * 在模型/IO 慢的日子不够，2026-08-15 A2 实测 renamed to 日志已出但 JSONL 尚无条目）。
	 * 返回最后一条 session_info entry；超时返回 null（调用方 assert 非空）。
	 */
	const waitSessionInfoEntry = async (timeoutMs = 10_000) => {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const lines = await readSessionLines();
			const entry = lines ? lastSessionInfoEntry(lines) : null;
			if (entry) return entry;
			if (Date.now() >= deadline) return null;
			await sleep(300);
		}
	};
	/** 读 session JSONL 行数组（文件不存在返回 null——pi 延迟写入契约）。 */
	const readSessionLines = async () => {
		const p = await sessionJsonlPath();
		if (!p || !existsSync(p)) return null;
		return readFileSync(p, "utf8").split("\n").filter((l) => l.length > 0);
	};

	return {
		proc,
		tmpDir,
		agentDir,
		sessionsDir,
		timelinePath,
		timeline,
		get piAlive() {
			return piAlive;
		},
		get exitInfo() {
			return exitInfo;
		},
		rpc: {
			send,
			request,
			waitFor,
			waitForSessionLog,
			prompt,
			setSessionName,
			getState,
			waitAgentSettled,
		},
		sessionJsonlPath,
		readSessionLines,
		waitSessionInfoEntry,
		kill,
		cleanup,
	};
}

/**
 * 场景 runner 通用执行器（单场景失败不阻断后续；四分类汇总）。
 * usage: await runScenario("A1", async (log) => { ... })
 */
export async function runScenario(name, fn) {
	const logs = [];
	const log = (msg) => {
		const line = `[${name}] ${msg}`;
		console.log(line);
		logs.push(line);
	};
	const t0 = Date.now();
	try {
		await fn(log);
		// 单次取值复用（原实现日志与返回值各算一遍 Date.now()-t0，两处毫秒位还会互相漂移）
		const durationMs = Date.now() - t0;
		log(`PASS (${(durationMs / 1000).toFixed(1)}s)`);
		return { name, ok: true, logs, durationMs };
	} catch (err) {
		const kind = classifyFailure(err);
		const durationMs = Date.now() - t0;
		log(`FAIL [${kind}] (${(durationMs / 1000).toFixed(1)}s): ${err?.message ?? err}`);
		if (err?.detail !== undefined) log(`detail: ${JSON.stringify(err.detail)}`);
		if (err?.stack) logs.push(err.stack);
		return { name, ok: false, kind, error: err, logs, durationMs };
	}
}

/**
 * 独立执行入口判定 + exit code 映射（run-aN.mjs 尾部共用，消除各场景重复样板）。
 * import.meta.url 必须由调用方传入——harness 模块内拿不到场景文件自身的 meta。
 */
export function runStandalone(moduleUrl, run) {
	const invoked = process.argv[1] && moduleUrl === pathToFileURL(process.argv[1]).href;
	if (!invoked) return;
	run().then((r) => {
		process.exitCode = r.ok ? 0 : 1;
	});
}

/** 从 `renamed to "..."` 日志行提取标题并断言与 session_info 落库一致。 */
export function assertLogTitleMatches(renameLine, persistedName) {
	const logTitle = renameLine.match(/renamed to "(.*)"$/)?.[1];
	assert(logTitle === persistedName, `日志标题与落库不一致: "${logTitle}" vs "${persistedName}"`);
}
