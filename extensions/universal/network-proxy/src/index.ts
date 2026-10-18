/**
 * @zhushanwen/pi-network-proxy 入口：配置驱动的 undici 全局分流分发器安装与事件接线。
 *
 * 行为序列（设计 .tmp/tech-design/llm-network-proxy.md §3.1）：
 * - 加载时：读配置校验，enabled 且校验过 → 捕获原分发器（pi 启动已自装 EnvHttpProxyAgent，
 *   setGlobalDispatcher 是接管而非向空闲槽安装）→ 构造分流器安装；校验失败 / 构造失败 →
 *   extension error（文案含恢复动作：配置文件路径），不安装不阻断 pi（全部直连）。
 * - 每 turn 开始：重读配置（llm-shared 读时刷新热重载），指纹变化才重建；enabled true→false
 *   恢复原分发器（installer.ts 状态机）。
 * - 每 turn 结束：计数增量 flush 追加写入 stats JSONL（stats.ts）；进程退出兜底 flush。
 *
 * 覆盖面含 subagent 的 pi 进程（subagent 的 LLM 请求同样分流计数，设计前提 P4）——不设
 * subagent 排除门。配置写入侧 = taiji runtime RMW（settings 页 RPC）或 pi CLI 用户手编。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";

import { toErrorMessage } from "@zhushanwen/pi-ext-guards";
import { getLogger, setPiHandle } from "@zhushanwen/pi-extension-logger";
import { getConfigPath } from "@zhushanwen/pi-llm-shared";

import { loadNetworkProxyConfig } from "./config.js";
import { buildProxyDispatcher } from "./dispatcher.js";
import { applyNetworkProxyConfig, type InstalledState } from "./installer.js";
import { ensureExitFlush, flushStats } from "./stats.js";

const logger = getLogger("network-proxy");

/** 进程级安装状态（模块级——全局分发器槽跨 session 存续，session 替换重跑 factory 不丢引用）。 */
let installed: InstalledState | null = null;

/** 恢复动作文案：所有 error 形态共用的收尾指引（指向配置文件）。 */
function recoveryHint(): string {
	return `配置文件: ${getConfigPath("network-proxy")}，修正该文件后自下一轮对话起生效，或删除该文件恢复默认禁用态。`;
}

/** 读配置并推进安装状态机（加载时与每 turn 开始共用同一入口）。 */
function refreshFromConfig(): void {
	const config = loadNetworkProxyConfig((warning) => {
		// 非法配置 / 坏 JSON：loadConfig 已回落 defaults（enabled=false → 不安装，全部直连），
		// 这里把具体错误呈现给用户（extension error，验收场景 10 的归因通道）。
		logger.error(`${warning} ${recoveryHint()}`);
	});
	try {
		installed = applyNetworkProxyConfig(config, installed, {
			getGlobalDispatcher,
			setGlobalDispatcher,
			buildProxy: buildProxyDispatcher,
			onError: (message) => logger.error(`${message} ${recoveryHint()}`),
		});
	} catch (error) {
		// 状态机异常（无已发生证据的防御——setGlobalDispatcher 抛错等）：不阻断 pi，
		// 保持未安装态，错误归因到本扩展日志。
		logger.error(`network-proxy installer failed: ${toErrorMessage(error)} ${recoveryHint()}`);
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
