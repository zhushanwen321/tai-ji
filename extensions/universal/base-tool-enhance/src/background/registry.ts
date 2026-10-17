/**
 * registry.json 持久化读写（per-sessionId 目录，D8）。
 *
 * 路径（session 存储树，session-store-layout-inversion 域 5）：
 * <dataDir>/ext-sessions/<sessionId>/background-tasks/registry.json。dataDir = taiji
 * 数据根（resolveTaijiDataDir 推导，由调用方解析传入）——不再是 pi getAgentDir()
 * （<dataDir>/agent，旧布局基址）；树根/域段常量与 shared paths.ts 同字面镜像（本包
 * 不 import @taiji/shared：包边界 + shared getDataDir 打包态门禁，同 system-prompt
 * 镜像先例），一致性由 scripts/check-artifact-dir-formula-sync.mjs 对拍机检守护。
 * 条目记 ownerPiPid——收殓侧属主判定依据（u-bte-remove 后 = taiji runtime
 * background-task-reaper），M2 只负责写入。
 *
 * 行为原语单点（ext-simplify-13）：解析防御 / corrupt 隔离 / 原子写 / 序列化 /
 * 终态 LRU 裁剪自 @zhushanwen/extension-protocol background-task 子出口引入——此前
 * 本地实现与 runtime 侧逐字同构、靠注释对齐；本模块只保留 bte 形态薄壳：Map 投影
 * readRegistry 与锁内 RMW 写壳。
 *
 * 写入协议：
 *  - 原子写 temp+rename、损坏读取防御（§3.6 重命名 .corrupt 保留现场 + 按空表
 *    重建）、终态条目 LRU 上限 50 均由 protocol 原语承担；诊断日志（corrupt 隔离
 *    warn 等）经 onLog 注入本包 logger，落盘通道不变
 *  - 锁内 RMW（@zhushanwen/pi-file-lock withFileLockSync）——同 sessionId 目录可能
 *    被桌面端 ephemeral 附着进程与发起进程并发写，跨进程互斥只依赖同一 lockfile
 *    （runtime 收殓器写终态用 taiji 统一锁，与该 lockfile 互斥）
 *  - 锁获取失败不降级无锁写：返回 {success:false}，条目停留 running 由 runtime
 *    收殓兜底（§3.5「registry/entry 写不进则条目停留 running」）
 */

import { join, resolve } from "node:path";

// 契约常量（LRU 上限）走 index 出口（background-task.ts 契约面）；行为原语走
// background-task 子出口（含 node 内建依赖，不进 index——renderer/core 零触达）
import { MAX_TERMINAL_REGISTRY_ENTRIES } from "@zhushanwen/extension-protocol";
import {
	atomicWriteRegistry,
	readRegistry as readRegistryEntries,
	serializeRegistryFile,
	trimTerminalEntries,
	type RegistryFileLogFn,
} from "@zhushanwen/extension-protocol/background-task";
import { toErrorMessage } from "@zhushanwen/pi-ext-guards";
import { getLogger } from "@zhushanwen/pi-extension-logger";
import { withFileLockSync } from "@zhushanwen/pi-file-lock";

import type { BackgroundTask, RegistryEntry } from "./types.ts";

const logger = getLogger("base-tool-enhance");

/** protocol registry 原语 → 本包 logger 适配（corrupt 隔离 warn 是排障生命线）。 */
const registryFileLog: RegistryFileLogFn = (level, event, detail) => logger[level](event, { detail });

/**
 * session 存储树根段镜像常量（session-store-layout-inversion D1）：`<dataDir>/ext-sessions/<sessionId>/…`。
 * shared 侧单点声明 = packages/shared/src/paths.ts 的 SESSION_STORE_DIR_SEGMENT /
 * getSessionStoreDir；本包不 import @taiji/shared（同 system-prompt 镜像理由），以同名字面量
 * 镜像，一致性由 scripts/check-artifact-dir-formula-sync.mjs 对拍机检守护。
 */
export const SESSION_STORE_DIR_SEGMENT = "ext-sessions";

/**
 * 后台任务域段镜像常量（session 存储树域 5）：`<dataDir>/ext-sessions/<sessionId>/background-tasks/`。
 * shared 侧单点 = getSessionBackgroundTasksDir 的域段（'background-tasks'），对拍机检逐字比对。
 */
export const BACKGROUND_TASKS_DIR_SEGMENT = "background-tasks";

/**
 * taiji dataDir 镜像推导（system-prompt resolveDataDir 同式）：TAIJI_AGENT_DATA_DIR 优先
 * （runtime 注入的权威值，与 getDataDir() 同源），缺失时 PI_CODING_AGENT_DIR
 * （=<dataDir>/agent）剥一层。pi getAgentDir() 恒指向 <dataDir>/agent，不能直接当存储树
 * 基址（新树挂 <dataDir>/ext-sessions）——旧布局 getAgentDir() 基址随换根退役。
 *
 * 每 handler 调用点现读 env（不缓存），env 变更即时生效（system-prompt 同款语义）。
 */
export function resolveTaijiDataDir(): string {
	if (process.env.TAIJI_AGENT_DATA_DIR) {
		return process.env.TAIJI_AGENT_DATA_DIR;
	}
	return resolve(process.env.PI_CODING_AGENT_DIR ?? "", "..");
}

/**
 * sessionId 同域校验（shared assertPiSessionId / runtime isPiSessionId 同域正则镜像：
 * 首尾字母数字，中间允许 [A-Za-z0-9._-]，禁冒号——btw 虚拟 id 必拒）。目录名即
 * sessionId，非法 id 会在 join 后逃逸出分区（路径穿越），统一在此 throw（fail-fast）。
 * 正则字面量三方一致性由对拍机检守护。
 */
function assertPiSessionId(sessionId: string): void {
	if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(sessionId)) {
		throw new Error(`invalid sessionId (path traversal blocked): ${sessionId}`);
	}
}

export function getRegistryPath(dataDir: string, sessionId: string): string {
	assertPiSessionId(sessionId);
	return join(dataDir, SESSION_STORE_DIR_SEGMENT, sessionId, BACKGROUND_TASKS_DIR_SEGMENT, "registry.json");
}

/**
 * 读取 registry 全量条目（Map 投影薄壳）。文件不存在 / 读失败 / 解析失败均返回
 * 空表（工具面不因 registry 问题崩溃）；解析失败由 protocol 原语重命名 .corrupt
 * 保留现场 + warn（§3.6）。
 */
export function readRegistry(registryPath: string): Map<string, RegistryEntry> {
	const { entries } = readRegistryEntries(registryPath, registryFileLog);
	return new Map(entries.map((e) => [e.taskId, e] as const));
}

/** BackgroundTask → RegistryEntry（剥离运行时字段 intent/timeoutTimer/child/registryPath）。 */
export function taskToRegistryEntry(task: BackgroundTask): RegistryEntry {
	return {
		taskId: task.taskId,
		pid: task.pid,
		command: task.command,
		outputFile: task.outputFile,
		startedAt: task.startedAt,
		state: task.state,
		ownerPiPid: task.ownerPiPid,
		sessionId: task.sessionId,
		...(task.exitCode !== undefined ? { exitCode: task.exitCode } : {}),
		...(task.reason !== undefined ? { reason: task.reason } : {}),
		...(task.endedAt !== undefined ? { endedAt: task.endedAt } : {}),
		...(task.durationMs !== undefined ? { durationMs: task.durationMs } : {}),
		...(task.tailSummary !== undefined ? { tailSummary: task.tailSummary } : {}),
		...(task.pidStartTime !== undefined ? { pidStartTime: task.pidStartTime } : {}),
	};
}

/**
 * 写入/更新单条 registry 条目（锁内 RMW：读全量 → 合并同 id 覆盖 → 终态 LRU 50 →
 * 原子写；读 / 裁剪 / 序列化 / 原子写由 protocol 原语承担）。任务登记（running）、
 * killing intent、终态三条路径共用。
 * 失败返回 {success:false}——调用方按「写不进则条目停留 running，runtime 收殓
 * 兜底」处理（M2 只 warn，不重试不阻断主流程）。
 */
export function writeRegistryEntry(
	registryPath: string,
	entry: RegistryEntry,
): { success: boolean; error?: string } {
	const writeMerged = (): void => {
		const { entries } = readRegistryEntries(registryPath, registryFileLog);
		const merged = new Map(entries.map((e) => [e.taskId, e] as const));
		merged.set(entry.taskId, entry);
		const trimmed = trimTerminalEntries([...merged.values()], MAX_TERMINAL_REGISTRY_ENTRIES);
		atomicWriteRegistry(registryPath, serializeRegistryFile(trimmed), registryFileLog);
	};
	try {
		withFileLockSync(registryPath, writeMerged);
		return { success: true };
	} catch (err) {
		// 锁壳层写失败 warn 是本模块职责（protocol 原语不发该日志——写失败时的
		// 「条目停留 running」降级决策在锁壳）
		const message = toErrorMessage(err);
		logger.warn("registry write failed; entry stays as-is (runtime reaper will collect the orphan)", {
			detail: { path: registryPath, taskId: entry.taskId, err: message },
		});
		return { success: false, error: message };
	}
}
