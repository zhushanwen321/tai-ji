/**
 * 有界失败闸门（D3，U2 / M2）——G2「失败必有界」的执行体。
 *
 * 通道选型（设计 §6.3；pi 0.84.1 实装，登记 PS-20）：
 *   参数层失败（事故主形态）在 pi-ai validateToolArguments 抛错（validation.js:272-273）、
 *   走 agent-loop 的 immediate error 路径（agent-loop.js:404 校验 → :445-451 catch）
 *   ——execute 不被调用、beforeToolCall 永不触发；唯一可靠
 *   的计数通道是 tool_execution_end 事件（sequential/parallel 两路径的 immediate
 *   分支均 emitToolExecutionEnd：agent-loop.js:277/:318/:348/:358）。
 *
 * 状态机：
 *   - 只统计 name=structured-output 的 isError 事件；其他工具的成功/失败均忽略。
 *   - 错误签名归一化（审查项#7 签名哈希化）：截掉 "Received arguments:" 起的实参
 *     回显后，提取错误字段/路径 token 集合排序哈希为签名——集合不变 = 模型无进展
 *     （重复同一批字段错误），集合变化（含缩小 = 渐进修复）= 模型在推进。旧 500c
 *     前缀截断在大 schema 下会把「修复排序靠后字段」（消息前缀不变）误折叠成同签名。
 *     required 错误的完整缺失字段列表从 message 解析并入 token（pi-ai bullet 路径位
 *     仅含 requiredProperties[0]，只取路径位会把「修好非首字段」折叠成同签名误杀）。
 *     AP 错误（D4 注入 additionalProperties:false，错误行无字段名）按错误行路径位
 *     下钻实参回显取该层 keys，以 key:<path>:<name> 形式并入——keys 是结构信息不是
 *     值：该层 keys 集合缩小 = 模型在删多余字段 = 真实进展；实参值变化（keys 不变）
 *     不产生新签名；嵌套 AP（路径位 a / a.b，R4-F2）下钻到嵌套层而非顶层——顶层
 *     keys 恒不变会把嵌套场景折叠成同签名误杀。AP 行检测为行级固定文案精确匹配
 *    （R4-F3，/additional propert/i 子串版会被字段名含该字样的非 AP 错误伪触发）。
 *     keys 并入按桶门控（仅错误行块含 AP 错误行时生效，见 normalizeErrorSignature
 *     的并集恒定陷阱注释）——required/格式类错误行天然携带字段名，keys 并入反而
 *     制造对流失衡。
 *   - 连续同签名失败达 MAX_CONSECUTIVE_FAILURES（3）→ terminal 态：
 *     写日志（stderr + appendEntry 双通道，含 §5.2 形态 b 恢复指引）后
 *     ctx.abort()（停当前 turn，截断 token 燃烧窗口）+ ctx.shutdown() 优雅终止
 *     子进程（RPC mode 在 agent_settled 后 exit），并武装 15s 兜底硬退 timer
 *    （R3 F-2 bounded teardown，覆盖 pi 挂死不 settle 的异常态）。
 *   - 成功调用清零（模型走通即无循环）。
 *
 * 与 workflow-hook 的关系：terminal 态经 onTerminal 回调标记 RetryState.terminal，
 * turn_end hook 据此不再 steer（防御性保留——shutdown 正常生效时进程已终止，
 * 该分支是 shutdown 失败路径下的保险）。
 *
 * 诚实边界（设计 §6.3）：闸门只终止「同签名无进展」这一种循环形态；签名不断
 * 变化的长尾低效不触发闸门，仍由 workflow 层 maxTurns 兜底。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { guardStaleCtx, isRecord, toErrorMessage } from "@zhushanwen/pi-ext-guards";

import { isToolExecutionEndEvent } from "./schema-guards.js";
import {
	extractToolErrorText,
	SIGNATURE_MAX_CHARS,
	truncateText,
} from "./text-primitives.js";

type PiAPI = ExtensionAPI;

// 依赖方向说明：本模块 → text-primitives（共享叶节点，导出复用勿复制）。原先经
// workflow-hook 取 extractToolErrorText 构成的模块环已破除——双方互引的纯函数/常量
// 下沉到 text-primitives，依赖图单向（loop-gate → text-primitives ← workflow-hook）。

/** 与 tool-definition.ts 的 TOOL_NAME 对应。 */
const TOOL_NAME = "structured-output";

/** 连续同签名失败阈值（设计 §6.3：对齐 qwen-code 的 3；workflow 子进程单用途短会话，更快失败更省）。 */
export const MAX_CONSECUTIVE_FAILURES = 3;

/** 实参回显起点标记（pi-ai validation.js 的 errorMessage 格式：错误行 + 空行 + 本标记 + 回显）。 */
const ARGS_ECHO_MARKER = "Received arguments:";

/**
 * TypeBox required message 形态（typebox locale en_US 逐字核实）：
 * "must have required properties X, Y, Z"——单缺失也是复数 "properties"，字段名为
 * 裸标识符 ", " 连接。解析恢复完整缺失字段列表；形态不符 → undefined（走路径位）。
 */
const REQUIRED_MESSAGE_RE = /must have required propert(?:y|ies) (.+)$/;

function parseRequiredMessageFields(message: string): string[] | undefined {
	const m = message.match(REQUIRED_MESSAGE_RE);
	if (!m) return undefined;
	const fields = m[1]!
		.split(",")
		.map((s) => s.trim())
		.filter((s) => /^[\w.\-/\[\]]+$/.test(s));
	return fields.length > 0 ? fields : undefined;
}

/**
 * required bullet 的路径位 = 父路径 + requiredProperties[0]（pi-ai formatValidationPath）。
 * 剥掉末尾首字段段得父路径前缀（"outer.inner" → "outer."；路径位即首字段 → ""），
 * 供 message 中每个缺失字段还原成全路径 token。形态意外（路径位不以首字段结尾）时
 * 退化为整段路径做前缀——token 仍确定性地区分不同缺失集合。
 */
function requiredBulletPrefix(bulletPath: string, firstField: string): string {
	if (bulletPath === firstField) return "";
	const suffix = `.${firstField}`;
	const base = bulletPath.endsWith(suffix) ? bulletPath.slice(0, -suffix.length) : bulletPath;
	return `${base}.`;
}

/**
 * AP（additionalProperties）错误行标记（R4-F3 精确化：行级固定文案匹配）。
 *
 * 旧实现 /additional propert/i 大小写不敏感子串匹配会被「字段名/字段列表恰好含该
 * 字样」的非 AP 错误伪触发（如 required message 列出名为 "additional properties"
 * 的字段）——keys 分桶被错误激活，与常规 token 并集对流（同分桶陷阱的伪 AP 变体，
 * 漏杀方向）。精确化后逐行匹配路径位之后的固定文案，字段名在冒号前不可能命中：
 *
 * 覆盖两种实装形态（均为固定文案，字段名不可能携带）：
 *   1. pi-ai 参数层 bullet（pi-ai 0.84.1 dist/utils/validation.js + typebox 1.3.7
 *      Compile 探针核实：message 恒为小写 "must not have additional properties"，
 *      行形态 `  - <path>: must not have additional properties`）——行级后缀匹配
 *      AP_LINE_SUFFIX_RE；路径位即 AP 层路径（root / a / a.b / list.0，
 *      formatValidationPath 对 instancePath 点分），供嵌套 keys 下钻（R4-F2）。
 *   2. 日常模式 ajv（execute.ts instancePath 拼接形态，ajv locale 模板大写 "must
 *      NOT have additional properties"）——模板词组含空格与固定语序，字段名不可能
 *      携带。该形态无 "Received arguments:" 回显段，keys 分桶天然不激活
 *      （hasApError 仅作标记；闸门仅 workflow 模式装配，此形态实为防御性保留）。
 */
const AP_LINE_SUFFIX_RE = /^(.*):\s*must not have additional properties\s*$/;
const AP_AJV_MESSAGE_RE = /must NOT have additional properties/;
/** pi-ai bullet message 位（冒号后）的 AP 固定文案原文（见上方探针核实记录）。 */
const AP_BULLET_MESSAGE = "must not have additional properties";

/**
 * 从（已剔除实参回显的）错误文本提取字段/路径 token 集合——修复进展的坐标：
 * 修一个字段必然改变失败字段集合，而消息前缀可能纹丝不动（大 schema 下错误行
 * 按序排列，靠后字段的修复不进 500c 前缀——旧前缀方案的误杀根源）。
 *
 * 覆盖两种错误形态（pi 实装版核实的 errorMessage 结构）：
 *   - pi-ai 参数层 bullet 行（validation.js：`  - ${formatValidationPath(error)}: ${message}`）：
 *     enum/类型等错误的字段名在 bullet 路径位：`  - assessments.0.impact: must be string`。
 *     required 是例外（F1）——formatValidationPath 只把 requiredProperties[0] 放进
 *     路径位，其余缺失字段名只在 message（"must have required properties alpha, beta,
 *     gamma"）；本函数解析 message 把完整缺失列表并入 token，否则「修好非首字段」
 *     （列表收缩 = 真实进展）会因路径位不变被折叠成同签名、3 次误杀。
 *   - 日常模式 ajv instancePath（execute.ts 拼接 `${err.instancePath} ${err.message}`）：
 *     `Schema validation failed: /count must be number`
 *
 * 有意决策（披露）：token 集合只含字段/路径、不含错误类型——同一字段换约束试错
 * （"must be string" → "must be number"）折叠为同签名。权衡：换取「集合不变 = 无进展」
 * 的强判定；代价是弱模型对单字段多约束的试错容忍度下降（同字段反复错达阈值即闸门）。
 *
 * 同时报告错误行块是否含 AP 错误行（hasApError）——normalizeErrorSignature 据此
 * 门控 echo keys 并入（分桶动机见该函数注释）；并收集 AP 错误行的路径位集合
 *（apPaths，R4-F2）——嵌套 AP 场景（schema 属性 a 下 AP:false，模型在 a 里逐个
 * 删多余字段）错误行路径位是 a（非 root），顶层 keys 恒不变 → 误杀；keys 必须
 * 按路径位下钻到该层才有进展信号（见 keysAtPath）。
 *
 * 提取不到 token（非校验类错误文本，如 "structured-output call failed"/网络错误）
 * 返回空数组——调用方 fallback 到 SIGNATURE_MAX_CHARS 前缀。
 */
function extractErrorFieldTokens(errorLines: string): {
	tokens: string[];
	hasApError: boolean;
	/** AP 错误行路径位集合（root / a / a.b / list.0）——嵌套 keys 下钻坐标。 */
	apPaths: string[];
} {
	const tokens = new Set<string>();
	const apPaths = new Set<string>();
	// 形态 1：bullet 行（路径位 + message）；字符类覆盖点分路径/数组索引/斜杠
	const bulletLine = /(?:^|\n)[ \t]*-[ \t]+([\w.\-/\[\]]+):[ \t]*([^\n]+)/g;
	// 形态 2：行首/空白/分号后的 ajv instancePath（/a/b/c）——排除紧贴前字符的斜杠
	//（避免把 bullet 路径里的 a/b 拆出半截 token 与形态 1 重复）
	const slashPath = /(?:^|[\s;])\/([\w.\-/\[\]]+)/g;
	for (const m of errorLines.matchAll(bulletLine)) {
		const path = m[1]!;
		const message = m[2]!;
		// AP bullet：message 位恒为固定文案（R4-F3 精确匹配）——路径位进下钻坐标集
		if (message.trim() === AP_BULLET_MESSAGE) {
			tokens.add(path);
			apPaths.add(path);
			continue;
		}
		const requiredFields = parseRequiredMessageFields(message);
		if (!requiredFields) {
			tokens.add(path);
			continue;
		}
		for (const field of requiredFields) {
			tokens.add(`${requiredBulletPrefix(path, requiredFields[0]!)}${field}`);
		}
	}
	// 非 bullet 形态的 AP 行兜底（路径位含 bullet 字符类外字符——空格/unicode 等）：
	// 行级后缀匹配（R4-F3 规定式 AP_LINE_SUFFIX_RE）并从冒号前抠路径位，同样进下钻
	// 坐标；bullet 已命中的行 Set 去重，无重复贡献。
	for (const line of errorLines.split("\n")) {
		const m = line.replace(/^[ \t]*-[ \t]+/, "").match(AP_LINE_SUFFIX_RE);
		if (m) apPaths.add(m[1]!.trim());
	}
	for (const m of errorLines.matchAll(slashPath)) {
		tokens.add(m[1]!);
	}
	return {
		tokens: [...tokens],
		hasApError: apPaths.size > 0 || AP_AJV_MESSAGE_RE.test(errorLines),
		apPaths: [...apPaths],
	};
}

/** FNV-1a 32-bit 参数：offset basis / prime（零依赖确定性哈希；签名仅用于等值比较，非加密场景）。 */
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
/** 32-bit 哈希输出为 8 位十六进制。 */
const HEX_RADIX = 16;
const HEX_WIDTH = 8;

function fnv1aHex(input: string): string {
	let hash = FNV_OFFSET_BASIS;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, FNV_PRIME);
	}
	return (hash >>> 0).toString(HEX_RADIX).padStart(HEX_WIDTH, "0");
}

/**
 * 字段集合规范形 → 哈希：排序去重后 join（token 字符类不含逗号，join 无歧义）。
 * 前缀带 token 数便于 appendEntry 日志肉眼判读（同数不同集靠哈希区分）。
 */
function fieldSetSignature(tokens: string[]): string {
	const canonical = [...tokens].sort().join(",");
	return `fields(${tokens.length})#${fnv1aHex(canonical)}`;
}

/** 签名 fallback 截断：裸切片不加 "..."（既有行为——上限即 500，锁定于测试）。 */
function truncateSignature(text: string): string {
	return text.length <= SIGNATURE_MAX_CHARS ? text : text.slice(0, SIGNATURE_MAX_CHARS);
}

/**
 * 按点分路径下钻实参对象，取该层 keys（R4-F2 嵌套 AP）。
 *
 * 路径位语义（pi-ai 0.84.1 formatValidationPath 探针核实）："root" = 实参对象本身
 * （根级 instancePath 为空的哨兵）；"a.b" / "list.0" = instancePath 点分下钻
 * （数组元素下标走数字段）。与「恰好有名为 root 的属性」的歧义由哨兵优先裁决
 *（取实参顶层 keys，不向下钻）——与 pi-ai 自身的渲染歧义同构，根级 AP 是主形态。
 *
 * 演进语义：该层 keys 集合缩小（模型在删该层多余字段）= 新签名——与根级同一
 * 「keys 是结构信息」契约。下钻中断（路径不存在 / 中间层非容器 / 目标层非 plain
 * object）该路径降级不贡献（返回空数组）——签名退化为错误行块口径，不比缺该路径更差。
 */
function keysAtPath(args: Record<string, unknown>, path: string): string[] {
	if (path === "root") return Object.keys(args);
	let current: unknown = args;
	for (const segment of path.split(".")) {
		if (Array.isArray(current)) {
			if (!/^\d+$/.test(segment)) return [];
			const index = Number(segment);
			if (index >= current.length) return [];
			current = current[index];
			continue;
		}
		if (!isRecord(current) || !(segment in current)) return [];
		current = current[segment];
	}
	return isRecord(current) ? Object.keys(current) : [];
}

/**
 * 从原始错误消息的 "Received arguments:" 段解析实参对象（AP 误杀修复的原料）。
 *
 * 背景（D4）：additionalProperties:false 默认注入后，模型带多余字段时 pi-ai 0.84.1
 * validation.js 报 "  - root: must not have additional properties"——bullet 路径位
 * 恒为 "root"（根级非 required 错误不进 formatValidationPath 特判，本机探针核实），
 * 错误行块不含多余字段名，字段 token 恒同集合；而模型逐个删除多余字段是真实进展，
 * 仅凭错误行块会折叠成同签名、3 次 terminal 误杀。实参回显段是
 * JSON.stringify(toolCall.arguments, null, 2) 产物（validation.js 逐字核实），可
 * JSON.parse——顶层 keys 是结构信息：keys 集合缩小 = 模型在删字段 = 进展 → 并入
 * token 集合产生新签名；嵌套 AP（R4-F2）则按 AP 错误行路径位下钻取该层 keys
 *（见 keysAtPath）。
 *
 * 与「剔除实参回显」既有语义的兼容区分（本意不变）：剔除回显的本意是「实参值变化
 * 不算进展」——keys 是结构不是值：值变化（keys 不变）不影响签名，既有语义保留；
 * keys 变化（结构变化）才产生新签名。回显段缺失 / JSON 解析失败 / 非 plain object
 * （null、数组、原始值）一律返回 undefined（不贡献 token）——签名退化为仅错误行
 * 块口径（如 steer 截断后的残缺回显、适配层改写过 errorMessage 的场景），不会比
 * 修复前更差。
 *
 * 调用方门控（并集恒定陷阱，见 normalizeErrorSignature 注释）：本函数结果仅在错误
 * 行块含 AP 错误行时以 key:<path>:<name> 前缀并入签名——required 渐进修复场景 keys
 * 与缺失列表对流，无条件并入会使 token 并集恒定、签名恒定，3 次误杀（实测教训）。
 */
function parseArgsEchoObject(errorText: string, markerIdx: number): Record<string, unknown> | undefined {
	const echoSection = errorText.slice(markerIdx + ARGS_ECHO_MARKER.length).trim();
	if (!echoSection) return undefined;
	try {
		const parsed: unknown = JSON.parse(echoSection);
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/**
 * 错误签名归一化（审查项#7：字段/路径 token 集合哈希；token 分桶版）：
 *   1. 剔除 "Received arguments:" 起的实参回显的「值」——值变化不等于进展（既有
 *      语义保留）。
 *   2. 提取字段/路径 token 集合，桶语义：
 *      - 常规桶（无前缀）：bullet 路径位 / required message 字段 / ajv instancePath
 *        （extractErrorFieldTokens 既有逻辑）——required/格式类错误行天然携带字段名，
 *        token 集合演化（含缩小）即进展坐标。
 *      - AP 桶（key:<path>:<name> 前缀）：仅当错误行块含 AP 错误行（hasApError）时，
 *        按 AP 错误行路径位（apPaths）下钻实参回显取该层 keys 并入——AP 错误行无
 *        字段名，keys 集合是唯一进展坐标（keys 缩小 = 删多余字段 = 进展）；嵌套 AP
 *        场景路径位是嵌套层（a / a.b），顶层 keys 恒不变，必须下钻（R4-F2）；路径
 *        限定防多 AP 层并存时同名 key 跨层折叠，也防 keys 与常规桶同名字段混淆。
 *   3. 集合不变 = 同签名（无进展）；集合变化 = 新签名（渐进修复不再被折叠）。
 *   4. 提取失败（无任何 token）fallback 到 500c 前缀硬上限（既有行为）。
 *
 * 并集恒定陷阱（keys 分桶动机，第四轮实测误杀教训）：旧实现把 echo keys 无条件
 * 并入常规 token（无前缀）。required 渐进修复场景下，模型每轮修好 1 个字段时该字段
 * 从错误行的缺失列表「迁移」到实参回显 keys——缺失 token 集缩小恰好被 keys 集增大
 * 抵消，token 并集恒定 → 签名恒定 → 第 3 次同签名 terminal 误杀（6 required 字段
 * 每轮修 1 个的探针实测复现：三轮签名恒 fields(6)#…）。而对流只发生在 required 类
 * 错误（错误行携带字段名 + 实参同步增长）；AP 错误行无字段名、keys 是其唯一信号——
 * 故按「是否存在 AP 错误行」门控 keys 并入：required/格式场景 keys 退出签名（进展
 * 由错误行 token 独家刻画），AP 场景 keys 进 AP 桶（机制保留）。
 *
 * 归一化对任意错误文本安全（非校验类错误 / 回显段残缺均走 fallback 或退化口径）。
 */
export function normalizeErrorSignature(errorText: string): string {
	const markerIdx = errorText.indexOf(ARGS_ECHO_MARKER);
	const errorLines = (markerIdx >= 0 ? errorText.slice(0, markerIdx) : errorText).trim();
	const { tokens, hasApError, apPaths } = extractErrorFieldTokens(errorLines);
	// echo keys 分桶门控（见上方并集恒定陷阱）：仅 AP 错误行存在时并入，带路径限定前缀
	//（key:<path>:<name>；嵌套层 keys 缩小 = 新签名，与根级同一演进契约）
	if (hasApError && markerIdx >= 0) {
		const args = parseArgsEchoObject(errorText, markerIdx);
		if (args) {
			for (const path of apPaths) {
				for (const key of keysAtPath(args, path)) {
					tokens.push(`key:${path}:${key}`);
				}
			}
		}
	}
	const unique = [...new Set(tokens)];
	return unique.length > 0 ? fieldSetSignature(unique) : truncateSignature(errorLines);
}

/**
 * structured-output 失败循环闸门状态机（纯逻辑，可单测）。
 *
 * 转移表（loop-gate.test.ts 锁定）：
 *   - onToolExecEnd(false)            → 计数/签名清零（成功短路）
 *   - onToolExecEnd(true, text)       → 签名同：计数++；签名异：计数=1（新一轮连续从此失败起算）
 *   - 计数达 MAX_CONSECUTIVE_FAILURES → terminal=true（不可逆；此后任何输入不再变化）
 */
export class LoopGate {
	terminal = false;
	private lastSignature: string | null = null;
	consecutiveFailures = 0;
	/** 最近一次失败的原始终态文本（截断后），供 terminal 日志引用。 */
	lastErrorText: string | null = null;

	/** 记录一次 structured-output tool 执行结果。hasError = event.isError === true。 */
	onToolExecEnd(hasError: boolean, errorText?: string): {
		terminal: boolean;
		/** 仅在「本次调用触发 terminal」时为 true（幂等：terminal 后恒 false）。 */
		newlyTerminal: boolean;
	} {
		if (this.terminal) return { terminal: true, newlyTerminal: false };

		if (!hasError) {
			this.consecutiveFailures = 0;
			this.lastSignature = null;
			this.lastErrorText = null;
			return { terminal: false, newlyTerminal: false };
		}

		const rawText = errorText ?? "structured-output call failed";
		this.lastErrorText = truncateText(rawText, SIGNATURE_MAX_CHARS);
		const signature = normalizeErrorSignature(rawText);
		if (signature === this.lastSignature) {
			this.consecutiveFailures++;
		} else {
			this.lastSignature = signature;
			this.consecutiveFailures = 1;
		}

		if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
			this.terminal = true;
			return { terminal: true, newlyTerminal: true };
		}
		return { terminal: false, newlyTerminal: false };
	}

	/** 当前归一化签名（字段集合哈希或 fallback 前缀；无失败史时 null；测试与日志用）。 */
	get signature(): string | null {
		return this.lastSignature;
	}
}

/** terminal 日志的 appendEntry customType（session.jsonl 持久化，不进 LLM 上下文）。 */
export const GATE_ENTRY_TYPE = "structured-output:gate";

/** 每秒毫秒数（teardown 日志 ms→s 换算用，no-magic-numbers）。 */
const MS_PER_SECOND = 1000;

/**
 * terminal 后 bounded teardown 的兜底硬退窗口（ms）。
 *
 * 任务原案 10s（SIGTERM 前优雅窗口）+ 5s（SIGKILL 前余量）的信号分级在扩展上下文
 * 不可达（pi 0.84.1 ExtensionContext 无子进程句柄/信号能力，见 armForceExitTeardown
 * 注释的核实记录），合并为单步 process.exit 硬退窗口。
 *
 * 数据完整性权衡（照任务要求写明）：session flush 在 shutdown 请求时已尽力——RPC
 * mode 于 agent_settled 后 exit，session entry 逐条 append 落盘（writeTerminatedLog
 * 的 entry 在 terminal 当下已写入）；15s 优雅窗口远超正常 flush 需求（abort+shutdown
 * 后正常退出秒级完成），兜底只覆盖「pi 挂死不 settle」的异常态——此时宁可硬退
 *（父进程 SW 侧走「子进程结束未产出 structured-output」失败路径，stderr 已留原因）
 * 也不无限烧 token。
 *
 * 安全域：15_000 为字面量常量，处于 Node setTimeout 安全域内（非有限/超 2^31-1
 * 会塌缩为 1ms 立即触发——若未来 delay 来源动态化，需引入安全域校验，参照
 * packages/subagent-core/src/shared/timer-delay.ts 的 assertSafeTimerDelay）。
 */
export const TEARDOWN_FORCE_EXIT_MS = 15_000;

/**
 * 兜底硬退 exit code：非零且 < 128（SW 侧 session-runner 的 SIGNAL_EXIT_CODE_THRESHOLD）
 * → 父进程按「子进程自身报错」记录（stderr 缓冲已先行写明原因），不会与信号终止混淆。
 */
const TEARDOWN_EXIT_CODE = 1;

// one-shot timer 不属 C-ext-06 §7.5 的「跨 session 存活进程级单例」范畴：
// terminal 一次性武装、随 process.exit 消亡；jiti 双实例下双 timer 各自
// process.exit 进程级幂等，模块级 let 即可。
let teardownTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * 武装 terminal 后的 bounded teardown 兜底：TEARDOWN_FORCE_EXIT_MS 后进程仍未退出
 *（pi 挂死未 settle）则 process.exit 硬退。
 *
 * 方案依据（pi 0.84.1 实装核实，node_modules/@earendil-works/pi-coding-agent
 * dist/core/extensions/types.d.ts + dist/core/extensions/runner.js）：
 * ExtensionContext 对外仅 shutdown()（优雅：置 shutdownRequested，agent_settled 后
 * exit）与 abort()（中止当前 agent 操作），无子进程句柄/信号 API；扩展与 pi 子进程
 * 同进程（loader 进程内加载），「向子进程发 SIGTERM/SIGKILL」在语义上不成立——扩展
 * 能做的最大硬杀就是对自身 process.exit。故采用任务预设的兜底形态：abort+shutdown
 * 优雅退出为主，定时 process.exit 兜底。
 *
 * timer 卫生：delay 为字面量常量、处 setTimeout 安全域（见 TEARDOWN_FORCE_EXIT_MS 注释）+
 * unref（不阻止 pi 在窗口内自然退出；自然退出时本 timer 随进程消亡不再开火）+
 * terminal 路径幂等 clearTimeout（重复武装不叠加多个兜底 timer）。
 */
export function armForceExitTeardown(): void {
	if (teardownTimer !== undefined) clearTimeout(teardownTimer);
	const timer = setTimeout(() => {
		process.stderr.write(
			`[structured-output gate] graceful shutdown did not complete within ${TEARDOWN_FORCE_EXIT_MS / MS_PER_SECOND}s; `
				+ "force-exiting (session flush was best-effort at shutdown request).\n",
		);
		process.exit(TEARDOWN_EXIT_CODE);
	}, TEARDOWN_FORCE_EXIT_MS);
	// unref：窗口内 pi 自然退出时不被本 timer 拖住（timer 随进程消亡，不再开火）
	timer.unref();
	teardownTimer = timer;
}

/**
 * terminal 态日志（§5.2 形态 b）：
 *   - stderr：子进程 stderr 直出（xyz-agent runtime 的 pi-*.jsonl tee / 本地探针可见）
 *   - appendEntry：session JSONL 持久化记录（事后排查通道，不进 LLM 上下文）
 * 两者内容同源，指引文案逐字对齐设计 §5.2。
 */
function writeTerminatedLog(pi: PiAPI, gate: LoopGate): void {
	const lastError = gate.lastErrorText ?? "(no error text)";
	const stderrLines = [
		`[structured-output gate] Terminated: the same validation error occurred ${MAX_CONSECUTIVE_FAILURES} times consecutively; shutting down this single-purpose workflow subprocess.`,
		`Last error: ${lastError}`,
		"👉 (workflow 作者) 检查 workflow 脚本的 outputSchema 是否过苛（深嵌套/超长 required），或更换更强模型后重跑该步骤。",
	].join("\n");
	// stderr 已销毁（EPIPE）时错误走流 error 事件而非同步 throw（同 cache-probe 惯例）
	process.stderr.write(`${stderrLines}\n`);

	try {
		pi.appendEntry(GATE_ENTRY_TYPE, {
			event: "terminated",
			consecutiveFailures: MAX_CONSECUTIVE_FAILURES,
			signature: gate.signature,
			lastError,
			guidance:
				"Check the workflow script's outputSchema (too strict / deep nesting / long required) or switch to a stronger model, then re-run this step.",
		});
	} catch (err) {
		// appendEntry 失败不阻断 shutdown——stderr 通道已落，此处补诊断（同 cache-probe 惯例）
		process.stderr.write(
			`[structured-output gate] appendEntry failed: ${toErrorMessage(err)}\n`,
		);
	}
}

export interface LoopGateOptions {
	/** terminal 触发时的回调（index.ts 用于标记 RetryState.terminal，hook 据此停 steer）。 */
	onTerminal?: () => void;
}

/**
 * 注册 tool_execution_end 闸门监听（仅 workflow 模式装配，见 index.ts）。
 *
 * terminal 触发时序（R3 F-2 bounded teardown）：onTerminal 回调（同步，先标记
 * hook 状态）→ 写日志（stderr + appendEntry 双通道，R3 F-3）→ ctx.abort()（中止
 * 当前 agent 操作——截断「shutdown 请求后当前 turn 的 bash/read/流式继续跑、模型
 * 继续烧 token」的窗口，~25s 实测窗口在 abort 后即止）→ ctx.shutdown()（RPC mode
 * 置 shutdownRequested，agent_settled 后进程 exit(0)，父进程走「子进程结束但未
 * 产出 structured-output」的既有失败路径）→ armForceExitTeardown()（15s 兜底硬退，
 * 覆盖 pi 挂死不 settle 的异常态；方案依据见该函数注释）。
 */
export function setupLoopGate(pi: PiAPI, options: LoopGateOptions = {}): LoopGate {
	const gate = new LoopGate();

	pi.on("tool_execution_end", async (event: unknown, ctx: ExtensionContext) => {
		if (!isToolExecutionEndEvent(event)) return;
		if (event.toolName !== TOOL_NAME) return;

		const outcome = gate.onToolExecEnd(
			event.isError === true,
			extractToolErrorText(event.result),
		);
		if (!outcome.newlyTerminal) return;

		options.onTerminal?.();
		writeTerminatedLog(pi, gate);
		// stale ctx 防御（crash-resilience D1）：abort/shutdown 均在 pi assertActive 面
		// （PS-30，runner.js createContext）——session 替换窗口触发 terminal 时无人接的
		// 同步 throw 会经 async handler 变 rejected Promise 杀 pi 进程。stale 静默跳过
		// 优雅退出（此时进程的存在意义已随 session 替换消失），armForceExitTeardown 的
		// 15s 硬退兜底保持武装——自清理语义不丢。非 stale 错误原样上抛（守卫不吞真实 bug）。
		guardStaleCtx(() => {
			ctx.abort();
			ctx.shutdown();
		}, {
			label: "structured-output:terminal-teardown",
			onStale: (error) => {
				process.stderr.write(
					`[structured-output gate] terminal teardown skipped (stale ctx, session replaced): `
						+ `${toErrorMessage(error)}; force-exit timer stays armed.\n`,
				);
			},
		});
		armForceExitTeardown();
	});

	return gate;
}
