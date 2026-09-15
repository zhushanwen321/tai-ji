/**
 * 历史配置路径迁移工具（幂等，过渡性——供 extension session_start hook 调用）。
 *
 * 迁移语义：
 * - 旧路径不存在 → noop
 * - 旧路径存在 + 新路径不存在 → renameSync 原子搬移
 * - 旧路径存在 + 新路径已存在 → 删除旧文件（新的是当前配置，旧的是残留副本；pi 运行时只读新路径）
 * - 失败 → warn 不抛错（best-effort，下次启动重试）
 *
 * 调用方在 session_start hook 里用模块级 once flag 防同进程重复触发。
 * agentDir 由调用方传入（通常 getAgentDir()），便于测试传 tmp dir。
 *
 * 设计依据见 docs/extensions/extension-conventions.md §配置路径约定「历史路径迁移」。
 */
import { existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

import { getLogger } from "@zhushanwen/pi-extension-logger";

const logger = getLogger("migrate-config");

export interface MigrationResult {
	migrated: boolean;
	/** 新路径已存在时已删除旧文件（清理残留副本），true 表示旧文件被删。 */
	removedLegacy?: boolean;
	/** 迁移失败时的错误对象（best-effort，不抛错）。 */
	error?: unknown;
}

/**
 * 迁移单个配置文件：`<agentDir>/<oldRel>` → `<agentDir>/<newRel>`。
 * 幂等、best-effort，重复调用安全。
 */
export function migrateLegacyConfig(agentDir: string, oldRel: string, newRel: string): MigrationResult {
	const oldPath = join(agentDir, oldRel);
	if (!existsSync(oldPath)) return { migrated: false };

	const newPath = join(agentDir, newRel);
	try {
		mkdirSync(dirname(newPath), { recursive: true });
		if (existsSync(newPath)) {
			// 新已存在 = 已迁移过（或用户用新路径），旧的是残留副本——删除清理。
			// pi 运行时只读新路径，旧文件无用。安全前提：session_start 迁移在 pi 进程内、
			// 用户主动启动时触发（非 postinstall 开发环境误触发；e112a14fc 场景随 session_start 消除）。
			unlinkSync(oldPath);
			logger.warn("new config already exists, removed legacy file", { detail: { oldPath } });
			return { migrated: false, removedLegacy: true };
		}
		renameSync(oldPath, newPath);
		logger.warn("migrated", { detail: { oldPath, newPath } });
		return { migrated: true };
	} catch (e) {
		logger.warn("migration failed", { detail: { oldPath, newPath, err: String(e) } });
		return { migrated: false, error: e };
	}
}
