/**
 * cache-probe — pi file-type extension（前缀稳定性长期数据采集探针）。
 *
 * 设计文档：docs/todo/cache-probe-design.md（§7.1 实现机制）。
 *
 * 记录 9 个指纹 hash（schema v2：短 hash + 增量 entry），变化时才向 session JSONL
 * 写 custom entry（customType = "cache-probe"）。custom entry 不进 LLM 上下文，
 * 探针零行为影响：
 *  - before_agent_start（每 turn 1 次）：算 7 个输入侧 hash 暂存 pending
 *    （systemPromptOptions 各字段 + getAllTools 注册表）
 *  - before_provider_request（每笔 LLM 请求，仅消费 turn 首笔）：从最终 payload
 *    提取 spFull（system 消息，兼容 system/developer/anthropic/google 口径）与
 *    toolsSent（tools 数组），与 pending 合并对比，变化/基线时 appendEntry
 *  - agent_end：turn 内无 provider 请求则丢弃 pending（无请求即无归因价值）
 *
 * seq = 进程内 before_agent_start 触发计数，随 entry 落盘供人工排序诊断；
 * 当前无自动消费方（analyze.py 不读 seq）。
 *
 * Fail-safe：handler 全程捕获，异常时写 error entry（缺口可见非静默）并重置为
 * 需基线状态；appendEntry 自身失败仅 stderr 诊断，绝不阻塞请求。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { toErrorMessage } from "@zhushanwen/pi-ext-guards";

import {
	buildProbeEntry,
	computePendingFingerprint,
	extractSystem,
	hashOf,
	SCHEMA_VERSION,
	sentToolsOf,
	type Fingerprints,
	type PendingFingerprint,
} from "./fingerprint";

const CUSTOM_TYPE = "cache-probe";

function stderr(msg: string): void {
	// stderr 已销毁（EPIPE）时错误走流 error 事件而非同步 throw，无需兜底 catch
	process.stderr.write(`[cache-probe] ${msg}\n`);
}

export default function (pi: ExtensionAPI): void {
	let seq = 0;
	let needsBaseline = true; // 初始 true 兜底 extension 加载晚于 session_start 的情况
	let startReason: string | null = null;
	let last: Fingerprints | null = null;
	let pending: PendingFingerprint | null = null;

	pi.on("session_start", (event) => {
		needsBaseline = true;
		startReason = event?.reason ?? null;
		last = null;
		pending = null;
	});

	pi.on("before_agent_start", (event) => {
		seq += 1;
		try {
			// 输入侧 7 hash 计算在 fingerprint.ts 纯函数层（handler 只做编排与 fail-safe）
			pending = computePendingFingerprint(event?.systemPromptOptions, pi.getAllTools());
		} catch (err) {
			stderr(`before_agent_start failed: ${toErrorMessage(err)}`);
			pending = null;
			try {
				pi.appendEntry(CUSTOM_TYPE, { v: SCHEMA_VERSION, seq, error: toErrorMessage(err) });
			} catch (appendErr) {
				stderr(`appendEntry failed: ${toErrorMessage(appendErr)}`);
			}
			needsBaseline = true;
		}
	});

	pi.on("before_provider_request", (event) => {
		if (!pending) return; // turn 首笔已被消费，或本 turn 无 before_agent_start 上下文
		const { cwd, parts } = pending;
		pending = null;
		try {
			const payload = event?.payload;
			const system = extractSystem(payload);
			const cur: Fingerprints = {
				...parts,
				spFull: system === null ? "no-system" : hashOf(system),
				toolsSent: sentToolsOf(payload) === null ? "no-tools" : hashOf(sentToolsOf(payload)),
			};
			const entry = buildProbeEntry(cur, last, { seq, needsBaseline, startReason, cwd });
			if (entry) pi.appendEntry(CUSTOM_TYPE, entry);
			last = cur;
			needsBaseline = false;
		} catch (err) {
			const msg = toErrorMessage(err);
			stderr(`before_provider_request failed: ${msg}`);
			try {
				pi.appendEntry(CUSTOM_TYPE, { v: SCHEMA_VERSION, seq, error: msg });
			} catch (appendErr) {
				stderr(`appendEntry failed: ${toErrorMessage(appendErr)}`);
			}
			needsBaseline = true;
		}
	});

	// turn 内没有任何 provider 请求（用户取消等）则丢弃 pending，防跨 turn 污染
	pi.on("agent_end", () => {
		pending = null;
	});
}
