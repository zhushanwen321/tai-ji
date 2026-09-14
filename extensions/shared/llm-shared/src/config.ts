/**
 * 泛型配置读写：getConfigPath + loadConfig<T> + saveConfig + mtime+size 缓存 + 原子写。
 *
 * 与 permission/config.ts 的区别：本库是泛型版（pkgName 参数化，normalize 由调用方传），
 * 不内置任何 schema —— rename-session / permission / smart-context / base-tool-enhance
 * 等 consumer 各自定义 normalize。
 * 范式（mtime+size 双 key 缓存、原子写 tmp+rename、tmp 失败清理）借鉴 permission/config.ts。
 *
 * 路径解析用 pi 导出的 getAgentDir（尊重 PI_CODING_AGENT_DIR 覆盖），禁止自实现 ——
 * [HISTORICAL] permission/config.ts 曾有重复自实现，P3 已清理（现全部委托本库），
 * 本库直接用 pi 导出版。
 *
 * ── 热重载契约（consumer 必读） ──
 * 本库的 loadConfig 提供「读时刷新（pull-based）热重载」：每次调用 statSync 文件 mtime+size，
 * 变了才重读+重新 normalize，没变返回深拷贝（成本≈一次 metadata stat，不读文件内容）。
 * 这是框架对 consumer 统一提供的热重载能力——consumer 应在【每次需要配置时直接调 loadConfig】，
 * 禁止在上层套手动缓存/闭包缓存（如 `let config = loadXxx()` + 手动 refresh 调用点），否则阻断
 * 读时刷新，导致「同进程内改文件不生效」。
 * 历史教训：permission 曾用闭包缓存架空了 loadConfig 的读时刷新——tool_call handler 拿闭包
 * 里的旧 config，传了 refresh 参数却未调用（_refreshConfig 下划线=未用），同一 session 改配置
 * 文件后下次工具调用仍用旧 config。正确范式见 rename-session（每次 turn_end 直接 load）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { toErrorMessage } from "@zhushanwen/pi-ext-guards";
import { getLogger } from "@zhushanwen/pi-extension-logger";
import { withFileLockSync } from "@zhushanwen/pi-file-lock";

const logger = getLogger("llm-shared");

/** JSON 序列化缩进格数（permission/config.ts 同款）。 */
const JSON_INDENT = 2;

// ──────────────────────── 路径 ────────────────────────

/** 配置文件完整路径：<agentDir>/config/<pkgName>-ext-config.json（与 config skill 名 `<简名>-ext-config` 统一）。 */
export function getConfigPath(pkgName: string): string {
	return join(getAgentDir(), "config", `${pkgName}-ext-config.json`);
}

// ──────────────────────── mtime+size 缓存 ────────────────────────

interface CacheEntry<T> {
	mtimeMs: number;
	size: number;
	config: T;
}

/**
 * 模块级缓存：path → {mtimeMs, size, config}。单进程多 session 共享读缓存安全（配置只读）。
 * mtime + size 双 key：防 APFS 等文件系统 mtime 精度截断导致快速连续保存后缓存失效。
 * 已知 limitation：「同毫秒同字节大小但内容不同」的写入会误命中（概率极低，权衡采用 mtime+size）。
 */
const configCache = new Map<string, CacheEntry<unknown>>();

/** 测试用：清空缓存。 */
export function clearConfigCache(): void {
	configCache.clear();
}

/** 深拷贝（防调用方修改返回值污染缓存）。Node 22+ 内置 structuredClone。 */
function clone<T>(value: T): T {
	return typeof structuredClone === "function"
		? structuredClone(value)
		: (JSON.parse(JSON.stringify(value)) as T);
}

// ──────────────────────── 加载（带缓存） ────────────────────────

/**
 * 加载配置，文件未变化时返回缓存（深拷贝，防调用方修改污染缓存）。
 *
 * @param pkgName 包名（决定文件路径 <agentDir>/config/<pkgName>-ext-config.json）
 * @param defaults 文件缺失/坏 JSON/normalize 失败时的默认值
 * @param normalize 把 JSON.parse 的 unknown 归一化成 T（调用方负责校验 + 默认值填充）
 * @param onWarning 非致命问题（解析失败）的警告回调
 *
 * 降级：文件不存在 → defaults；坏 JSON / normalize throw → defaults（onWarning 回调）。
 * 坏文件也更新缓存 mtime+size（缓存 defaults），避免每次重读损坏文件；mtime 变化时缓存自动失效。
 *
 * 【热重载契约】本函数自带读时刷新：文件 mtime/size 变化时自动重读。consumer 每次需要配置直接
 * 调用本函数即可（文件未变时零额外 IO——只 statSync 不读内容），禁止在上层套闭包/手动缓存阻断
 * 刷新。详见文件头「热重载契约」段。
 */
export function loadConfig<T>(
	pkgName: string,
	defaults: T,
	normalize: (raw: unknown) => T,
	onWarning?: (msg: string) => void,
): T {
	const configPath = getConfigPath(pkgName);

	let stat;
	try {
		stat = statSync(configPath);
	} catch {
		// 文件不存在 / 不可 stat → defaults（不缓存，下次仍尝试读，文件创建后自动生效）
		return clone(defaults);
	}

	const cached = configCache.get(configPath) as CacheEntry<T> | undefined;
	if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
		return clone(cached.config);
	}

	try {
		const raw = readFileSync(configPath, "utf-8");
		const parsed: unknown = JSON.parse(raw);
		const config = normalize(parsed);
		configCache.set(configPath, { mtimeMs: stat.mtimeMs, size: stat.size, config });
		return clone(config);
	} catch (error) {
		const message = toErrorMessage(error);
		onWarning?.(`[llm-shared] Config parse failed at '${configPath}', using default: ${message}`);
		// 缓存 defaults + 当前 mtime/size，避免每次重读损坏文件（mtime 变化时缓存自动失效）
		configCache.set(configPath, { mtimeMs: stat.mtimeMs, size: stat.size, config: clone(defaults) });
		return clone(defaults);
	}
}

// ──────────────────────── 保存（锁内原子写） ────────────────────────

/**
 * 生成并发唯一的 tmp 文件名（D1e 附带风险修复：双侧 tmp 中间文件同名 `<path>.tmp`
 * 并发可碰撞——runtime 侧 atomicWrite 未传 uniqueSuffix 也是固定名，扩展侧唯一化
 * 后两侧名字空间不相交，碰撞面消除）。
 *
 * 后缀 = pid + 36 进制随机段：同进程多写方（多 session）与跨进程写方均不重名。
 */
const TMP_RANDOM_BASE = 36;
const TMP_RANDOM_SLICE_START = 2; // 跳过 Math.random 字符串的 "0." 前缀
const TMP_RANDOM_SLICE_END = 10;
function uniqueTmpPath(configPath: string): string {
	return `${configPath}.tmp_${process.pid}_${Math.random().toString(TMP_RANDOM_BASE).slice(TMP_RANDOM_SLICE_START, TMP_RANDOM_SLICE_END)}`;
}

/**
 * 保存配置（锁内原子写：withFileLockSync + tmp 文件 + rename）。
 *
 * @returns 成功 {success:true}；失败 {success:false, error}
 *
 * 🔒 跨进程锁（D1e/W4，integrity-hardening.md §3.1，登记表 §6 rename-session 行）：
 * ext-config 家族被 xyz runtime（如 setRenameModel 写 model 字段，W1b 已持锁）与
 * pi 子进程内扩展（本函数）双写。互斥只依赖同一 lockfile（<config>.lock），本侧
 * withFileLockSync 协议与 runtime 侧 settings.json 写锁逐字对齐（realpath:false +
 * stale 30s + busy-wait 1s 预算 fail-fast）。锁获取失败不降级无锁写——对端
 * runtime 可能正持锁写，无锁写会交错丢字段；返回 {success:false} 由调用方按
 * 保存失败处理（下次 save 重试）。
 *
 * 原子性：writeFileSync(tmp) + renameSync(tmp→target)，rename 是原子的（POSIX/Windows）。
 * tmp 失败清理（review RK3）：writeFileSync 或 renameSync 抛错时，catch 块 unlinkSync(tmp)
 * 清理残留 tmp 文件（unlink 本身 try/catch，避免二次抛错）。
 * 写后立即 statSync 更新缓存（覆盖最常见的「写后读」竞态）。
 *
 * Windows 行为说明（探针 4）：renameSync 在目标文件被占用（打开句柄未关闭）时抛 EPERM，
 * 无 fallback —— catch 路径返回 {success:false} + onWarning + tmp 清理，调用方（配置写入方）
 * 应视保存失败处理（如保留内存态、下次触发重写）。非致命：配置写入失败不影响运行，
 * 下次 save 仍会重试。单测见 __tests__/config.test.ts 的 ENOENT/EPERM 用例。
 */
export function saveConfig(
	pkgName: string,
	config: unknown,
	onWarning?: (msg: string) => void,
): { success: boolean; error?: string } {
	const configPath = getConfigPath(pkgName);
	const tmpPath = uniqueTmpPath(configPath);
	const content = `${JSON.stringify(config, null, JSON_INDENT)}\n`;

	const writeLocked = (): { success: boolean; error?: string } => {
		try {
			mkdirSync(dirname(configPath), { recursive: true });
			writeFileSync(tmpPath, content, { encoding: "utf-8", mode: 0o600 });
			renameSync(tmpPath, configPath);

			// 写后更新缓存（用新文件 mtime+size + 写入的 config）
			try {
				const newStat = statSync(configPath);
				configCache.set(configPath, {
					mtimeMs: newStat.mtimeMs,
					size: newStat.size,
					config: clone(config),
				});
			} catch (statErr) {
				// stat 失败不影响保存成功；缓存下次 load 时会重读
				logger.warn("saveConfig stat after write failed", { detail: { err: toErrorMessage(statErr) } });
			}

			return { success: true };
		} catch (error) {
			// RK3: 清理残留 tmp 文件（writeFileSync 或 renameSync 失败时 tmp 可能残留）
			try {
				if (existsSync(tmpPath)) unlinkSync(tmpPath);
			} catch (cleanupErr) {
				// tmp 清理失败不能阻塞保存失败的返回；记录原因
				logger.warn("saveConfig tmp cleanup failed", { detail: { err: toErrorMessage(cleanupErr) } });
			}
			const message = toErrorMessage(error);
			onWarning?.(`[llm-shared] Failed to save config at '${configPath}': ${message}`);
			return { success: false, error: `Failed to save config at '${configPath}': ${message}` };
		}
	};

	try {
		return withFileLockSync(configPath, writeLocked);
	} catch (lockErr) {
		// 锁获取失败（ELOCKED 预算耗尽等）：不降级无锁写（见 docstring），按保存失败返回
		const message = toErrorMessage(lockErr);
		onWarning?.(`[llm-shared] Config write lock unavailable at '${configPath}': ${message}`);
		return { success: false, error: `Config write lock unavailable at '${configPath}': ${message}` };
	}
}
