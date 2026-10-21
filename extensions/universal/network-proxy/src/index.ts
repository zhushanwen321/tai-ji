/**
 * @zhushanwen/pi-network-proxy 入口：配置驱动的 globalThis.fetch 包装与事件接线。
 *
 * 行为序列（fetch-wrapper.ts 头注有完整设计依据）：
 * - 加载时：读配置校验，enabled 且校验过 → 包装 globalThis.fetch（命中规则走代理，
 *   未命中委托原 fetch）；校验失败 / 构造失败 → extension error（文案含恢复动作：
 *   配置文件路径），不包装不阻断 pi（全部直连）。
 * - 每 turn 开始：重读配置（llm-shared 读时刷新热重载），指纹变化才重建；enabled true→false
 *   恢复原 fetch（fetch-wrapper.ts 状态机）。
 * - 每 turn 结束：计数增量 flush 追加写入 stats JSONL（stats.ts）；进程退出兜底 flush。
 *
 * 覆盖面含 subagent 的 pi 进程（subagent 的 LLM 请求同样分流计数，设计前提 P4）——不设
 * subagent 排除门。配置写入侧 = taiji runtime RMW（settings 页 RPC）或 pi CLI 用户手编。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fetch as undiciFetch } from "undici";

import { toErrorMessage } from "@zhushanwen/pi-ext-guards";
import { getLogger, setPiHandle } from "@zhushanwen/pi-extension-logger";
import { getConfigPath } from "@zhushanwen/pi-llm-shared";

import { loadNetworkProxyConfig } from "./config.js";
import { buildIpv4Dispatcher, buildProxyDispatcher } from "./dispatcher.js";
import {
	applyNetworkProxyConfig,
	detachResidualFetchWrapper,
	type FetchWrapperDeps,
	type FetchWrapperState,
	type ProxyFetch,
} from "./fetch-wrapper.js";
import { ensureExitFlush, flushStats } from "./stats.js";

const logger = getLogger("network-proxy");

/** 进程级包装状态（模块级——globalThis.fetch 是进程级资源，session 替换重跑 factory 不丢引用）。 */
let installed: FetchWrapperState | null = null;

/** 恢复动作文案：所有 error 形态共用的收尾指引（指向配置文件）。 */
function recoveryHint(): string {
	return `配置文件: ${getConfigPath("network-proxy")}，修正该文件后自下一轮对话起生效，或删除该文件恢复默认禁用态。`;
}

/**
 * 代理 fetch 适配：pi-ai 的 global Request/Response 与 undici.fetch 的 web 标准类型同构，
 * 运行时直接透传；dispatcher 由 fetch-wrapper 注入到 init。
 */
const proxyFetch: ProxyFetch = (input, init) =>
	undiciFetch(
		input as Parameters<typeof undiciFetch>[0],
		init as Parameters<typeof undiciFetch>[1],
	);

const deps: FetchWrapperDeps = {
	getFetch: () => globalThis.fetch,
	setFetch: (fetch) => {
		globalThis.fetch = fetch;
	},
	buildProxy: buildProxyDispatcher,
	buildIpv4: buildIpv4Dispatcher,
	proxyFetch,
	onError: (message) => logger.error(`${message} ${recoveryHint()}`),
};

/** 读配置并推进包装状态机（加载时与每 turn 开始共用同一入口）；推进前先摘除 reload 残留。 */
function refreshFromConfig(): void {
	const config = loadNetworkProxyConfig((warning) => {
		// 非法配置 / 坏 JSON：loadConfig 已回落 defaults（enabled=false → 不包装，全部直连），
		// 这里把具体错误记录到 extension 日志通道（appendEntry 持久化 + <agentDir>/logs/
		// network-proxy-<day>.log 文件日志；验收场景 10 以文件日志为归因口径）。
		logger.error(`${warning} ${recoveryHint()}`);
	});
	try {
		if (typeof globalThis.fetch !== "function") {
			logger.error(`globalThis.fetch 不可用，网络代理不生效（全部直连）。${recoveryHint()}`);
			installed = null;
			return;
		}
		detachResidualFetchWrapper(installed, deps);
		installed = applyNetworkProxyConfig(config, installed, deps);
	} catch (error) {
		// 辅助功能降级契约（本扩展为 P2 辅助功能，故障不得拖垮 pi 主流程）：状态机推进的
		// 意外异常不外抛——外抛会升为 pi 用户可见 extension error 且每 turn 重复出现；
		// 此处保持未包装态（全部直连），错误归因到本扩展日志。
		logger.error(`network-proxy state update failed: ${toErrorMessage(error)} ${recoveryHint()}`);
		installed = null;
	}
}

/** pi-network-proxy extension 工厂函数。 */
export default function networkProxyExtension(pi: ExtensionAPI): void {
	// 日志通道注入（extension-logger 两阶段初始化：工厂拿 pi → setPiHandle，最早期调用）。
	setPiHandle(pi);

	ensureExitFlush();
	refreshFromConfig();

	// turn 粒度热生效：turn 开始重读配置（mtime+size 未变时零 IO），指纹变化重建 / 禁用恢复。
	pi.on("turn_start", () => {
		refreshFromConfig();
	});

	// turn 结束 flush 计数增量（单行 JSONL 追加，写失败 log 不阻断）。
	pi.on("turn_end", () => {
		flushStats();
	});
}
