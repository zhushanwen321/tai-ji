/**
 * cache-probe 指纹纯函数层 —— 设计文档 docs/todo/cache-probe-design.md §7.1。
 *
 * entry schema v2（长期生效版，数据量精简为长期采集优化）：
 *  - hash 用 sha256 前 16 hex（64bit，同 session 内对比，碰撞概率可忽略）
 *  - baseline entry 存全量 9 hash + cwd + startReason
 *  - normal entry 只存变化项（增量 merge，脚本侧回放合并）
 *  - error entry 只存 v/seq/error
 */

import { createHash } from "node:crypto";

import { isRecord } from "@zhushanwen/pi-ext-guards";

/** 指纹 hash 长度（hex 字符数）。 */
const HASH_LEN = 16;

/** entry schema 版本（v2：短 hash + 增量 entry）。 */
export const SCHEMA_VERSION = 2;

export type FingerprintKey =
	| "spFull"
	| "toolsSent"
	| "contextFiles"
	| "skills"
	| "toolsList"
	| "toolsReg"
	| "append"
	| "guidelines"
	| "customPrompt";

export type Fingerprints = Record<FingerprintKey, string>;

export interface ProbeEntryData {
	v: typeof SCHEMA_VERSION;
	seq: number;
	baseline?: true;
	startReason?: string;
	cwd?: string;
	changed?: string[];
	/** baseline 存全量；normal 只存变化项。 */
	h?: Partial<Fingerprints>;
	error?: string;
}

/** 递归 sort keys 的稳定序列化（undefined 归一为 null，防 key 顺序抖动产生假变化）。 */
function stableStringify(value: unknown): string {
	if (value === undefined) return "null";
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
	const keys = Object.keys(value).sort();
	return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify((value as Record<string, unknown>)[k])).join(",") + "}";
}

export function hashOf(value: unknown): string {
	return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, HASH_LEN);
}

/**
 * 从 provider payload 提取 system 内容（最终视角）。三种口径：
 *  - OpenAI 兼容：messages 内 role 为 system 或 developer
 *    （pi 源码 ai/src/api/openai-completions.ts 的 useDeveloperRole 分支）
 *  - Anthropic：顶层 system（数组）
 *  - Google：顶层 systemInstruction（对象）
 */
export function extractSystem(payload: unknown): unknown | null {
	if (!isRecord(payload)) return null;
	const system = payload["system"];
	if (Array.isArray(system)) return system;
	const systemInstruction = payload["systemInstruction"];
	if (isRecord(systemInstruction)) return systemInstruction;
	const messages = payload["messages"];
	if (Array.isArray(messages)) {
		const sys = messages.filter(
			(m): m is Record<string, unknown> =>
				isRecord(m) && (m["role"] === "system" || m["role"] === "developer"),
		);
		if (sys.length > 0) return sys;
	}
	return null;
}

/** 从 provider payload 提取最终发送的 tools 数组；缺失返回 null。 */
export function sentToolsOf(payload: unknown): unknown[] | null {
	if (!isRecord(payload)) return null;
	const tools = payload["tools"];
	return Array.isArray(tools) ? tools : null;
}

function diffFingerprints(cur: Fingerprints, last: Fingerprints | null): FingerprintKey[] {
	if (last === null) return [];
	return (Object.keys(cur) as FingerprintKey[]).filter((k) => last[k] !== cur[k]);
}

/** systemPromptOptions 的结构子集（探针只读这些字段；宽松类型避免纯函数层耦合 SDK）。 */
export interface SystemPromptOptionsLike {
	cwd?: string | null;
	contextFiles?: unknown;
	skills?: unknown;
	selectedTools?: unknown;
	toolSnippets?: unknown;
	appendSystemPrompt?: unknown;
	promptGuidelines?: unknown;
	customPrompt?: unknown;
}

/** before_agent_start 暂存的输入侧指纹（payload 侧 spFull/toolsSent 到 provider 请求时补齐）。 */
export interface PendingFingerprint {
	cwd: string | null;
	parts: Omit<Fingerprints, "spFull" | "toolsSent">;
}

/** getAllTools 注册表条目归一（非对象/缺字段归 null，形态稳定后参与 toolsReg hash）。 */
function normalizeTool(t: unknown): { name: unknown; description: unknown; parameters: unknown; promptGuidelines: unknown } {
	if (!isRecord(t)) return { name: null, description: null, parameters: null, promptGuidelines: null };
	return {
		name: t["name"] ?? null,
		description: t["description"] ?? null,
		parameters: t["parameters"] ?? null,
		promptGuidelines: t["promptGuidelines"] ?? null,
	};
}

/**
 * before_agent_start 输入侧 7 hash 计算（handler 只做编排，纯函数便于单测）。
 * null 容忍语义与 turn 侧一致：缺省字段归一为 null 再 hash，防 undefined/null 抖动产生假变化。
 */
export function computePendingFingerprint(
	o: SystemPromptOptionsLike | null | undefined,
	tools: readonly unknown[] | null | undefined,
): PendingFingerprint {
	const opts = o ?? {};
	return {
		cwd: opts.cwd ?? null,
		parts: {
			contextFiles: hashOf(opts.contextFiles ?? null),
			skills: hashOf(opts.skills ?? null),
			toolsList: hashOf([opts.selectedTools ?? null, opts.toolSnippets ?? null]),
			append: hashOf(opts.appendSystemPrompt ?? null),
			guidelines: hashOf(opts.promptGuidelines ?? null),
			customPrompt: hashOf(opts.customPrompt ?? null),
			toolsReg: hashOf((tools ?? []).map(normalizeTool)),
		},
	};
}

/**
 * 构建待写入的 probe entry；无变化返回 null（不写 entry，session 零膨胀）。
 * baseline 全量；normal 增量。cwd 仅 baseline 携带（cwd 变化必然带动 contextFiles 变化，
 * 变化事实由 changed 体现，诊断回溯最近 baseline）。
 */
export function buildProbeEntry(
	cur: Fingerprints,
	last: Fingerprints | null,
	meta: { seq: number; needsBaseline: boolean; startReason: string | null; cwd: string | null },
): ProbeEntryData | null {
	if (meta.needsBaseline || last === null) {
		return {
			v: SCHEMA_VERSION,
			seq: meta.seq,
			baseline: true,
			startReason: meta.startReason ?? undefined,
			cwd: meta.cwd ?? undefined,
			changed: ["*"],
			h: cur,
		};
	}
	const changed = diffFingerprints(cur, last);
	if (changed.length === 0) return null;
	const delta: Partial<Fingerprints> = {};
	for (const k of changed) delta[k] = cur[k];
	return { v: SCHEMA_VERSION, seq: meta.seq, changed, h: delta };
}
