/**
 * 请求计数与落盘（设计 .tmp/tech-design/llm-network-proxy.md §3.1 行为序列 4 + §3.3 决策 4）。
 *
 * 形态 = 进程内内存增量计数 + turn_end / 进程退出时追加式 JSONL flush：
 * - 计数按主机名聚合，进程级（分流分发器是全局槽资源，与 session 无关）；
 * - 每行一个完整 JSON 片段 `{ ts, host, proxied, direct }`，ts = flush 时刻——增量行代表
 *   「自上次 flush 以来的计数」，跨统计范围边界的微小归属偏差可接受（观测辅助非计费依据）；
 * - 落点 `<getAgentDir()>/network-proxy-stats.jsonl`（agentDir 根，与 runtime 读侧
 *   getPiAgentDir() 单一推导同源）；runtime 侧负责聚合与重置水位/截断，本侧纯追加；
 * - 单行 = 单次 appendFileSync 调用（O_APPEND 单次 write，行内容完整 JSON——并发原子性
 *   前提，多 pi 进程并发追加不交错；实现改为分片 write 会静默交错，单测锁定）；
 * - 写失败 log 不阻断：失败行的增量保留在内存，下次 turn_end flush 重试（统计宁重试不丢，
 *   连续失败不逐行刷 warn）。
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { toErrorMessage } from "@zhushanwen/pi-ext-guards";
import { getLogger } from "@zhushanwen/pi-extension-logger";
import { withFileLockSync } from "@zhushanwen/pi-file-lock";

const logger = getLogger("network-proxy");

interface HostCounter { // oe-exempt:20261019:framework:进程内计数行形状（Map 值类型，聚合输出 NetworkProxyStats 的内存态）

	proxied: number;
	direct: number;
}

/** 进程内增量计数：host → 自上次 flush 以来的次数。 */
const counters = new Map<string, HostCounter>();

/** stats 文件完整路径（每次现算——getAgentDir 尊重 PI_CODING_AGENT_DIR，测试注入 tmp）。 */
export function statsFilePath(): string {
	return join(getAgentDir(), "network-proxy-stats.jsonl");
}

/** dispatch 拦截点的计数回调（请求发起时点）。 */
export function recordDispatch(host: string, proxied: boolean): void {
	const entry = counters.get(host) ?? { proxied: 0, direct: 0 };
	if (proxied) {
		entry.proxied += 1;
	} else {
		entry.direct += 1;
	}
	counters.set(host, entry);
}

/** 测试用：清空内存增量（不落盘）。 */
export function resetCounters(): void {
	counters.clear();
}

/** 测试用：当前增量快照（只读拷贝）。 */
export function snapshotCounters(): Map<string, HostCounter> {
	return new Map([...counters].map(([host, c]) => [host, { ...c }]));
}

let exitFlushInstalled = false;

/**
 * 进程退出 flush（turn 进行中被退出时 turn_end 未到，增量在此兜住）。exit handler 内只允许
 * 同步操作——appendFileSync 同步写满足；模块级 once flag 防工厂重跑（多 session）重复注册。
 * jiti 全量 reload 产生的新模块环境会再注册一个 listener，但旧环境的计数 Map 已停更，旧
 * listener flush 空增量为 no-op，无重复行（新环境再注册 = extensions/loader.js:472-476 重新
 * import 重置模块级 once flag 后重跑工厂；旧计数停更 = 旧 runtime 的 turn 订阅被 invalidate
 * 退订（extensions/loader.js:147-149）+ 旧 fetch 包装摘除后旧 recordDispatch 不再触发；pi reload
 * 链总锚点见 fetch-wrapper.ts detachResidualFetchWrapper 注释）。
 */
export function ensureExitFlush(): void {
	if (exitFlushInstalled) return;
	exitFlushInstalled = true;
	process.on("exit", () => {
		try {
			flushStats();
		} catch (error) {
			// flushStats 内部已逐行 try/catch + warn——能到这里的外层抛错只有 mkdir/logger 自身
			// 故障；exit 通道内不能阻断退出，留文件日志痕即可。
			logger.error(`exit flush failed: ${toErrorMessage(error)}`);
		}
	});
}

/**
 * 把内存增量逐行追加写入 stats 文件；写成功的条目从内存清零，失败条目保留待下次重试。
 * 增量为空时零 IO 直接返回（turn_end 空转不碰磁盘）。
 * 持与 runtime 截断/重置同一把 <stats> 跨进程文件锁（设计 §3.1「截断不丢在途增量」）：
 * runtime 保尾截断临界区内并发追加的行会被 rename 整文件替换吞掉，无锁单侧互斥不成立。
 * ts = epoch ms（Date.now()，与 runtime 读侧 parseStatsLine number 契约、reset 水位行
 * 及读侧时间范围过滤一致；ISO 字符串形态产生的行会被读侧判坏行丢弃）。
 */
export function flushStats(): void {
	if (counters.size === 0) return;
	const ts = Date.now();
	const filePath = statsFilePath();
	try {
		withFileLockSync(filePath, () => {
			try {
				mkdirSync(dirname(filePath), { recursive: true });
			} catch (error) {
				logger.warn("stats mkdir failed, keeping counters for retry", {
					detail: { err: toErrorMessage(error) },
				});
				return;
			}
			for (const [host, counter] of counters) {
				// 单次 appendFileSync 调用写一行完整 JSON——并发原子性前提，禁止分片 write
				const line = `${JSON.stringify({ ts, host, proxied: counter.proxied, direct: counter.direct })}\n`;
				try {
					appendFileSync(filePath, line);
					counters.delete(host);
				} catch (error) {
					logger.warn("stats flush failed, keeping counters for retry", {
						detail: { err: toErrorMessage(error), path: filePath },
					});
					return;
				}
			}
		}, {});
	} catch (error) {
		logger.warn("stats flush lock failed, keeping counters for retry", {
			detail: { err: toErrorMessage(error), path: filePath },
		});
	}
}
