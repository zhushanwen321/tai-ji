/**
 * 安全环境变量构建（最小权限原则）。
 *
 * [HISTORICAL] 不变量（CLAUDE.md 规则：路径/ENV 白名单动态化）：
 * - ENV_WHITELIST 基于 shared 的 ENV_WHITELIST_PREFIXES（SSOT 在 shared/constants.ts），
 *   main 进程额外允许 ELECTRON_ 前缀
 * - safe-env.ts（主进程）= [...SSOT, 'ELECTRON_']；rpc-client.ts（子进程）= SSOT 全集
 * - Pre-commit check_env_whitelist_sync.py 验证 SSOT 单一性（定义只在 shared）
 *
 * 依赖方向：safe-env → shared（运行时常量 + 构建器 compose 层）
 */
import { ENV_WHITELIST_PREFIXES, composeChildEnvBase } from '@xyz-agent/shared'

/**
 * 子进程允许继承的环境变量前缀白名单。
 * 在 shared 白名单基础上扩展 ELECTRON_（main 进程专属）。
 */
export const ENV_WHITELIST: readonly string[] = [...ENV_WHITELIST_PREFIXES, 'ELECTRON_']

/**
 * 构建最小权限环境变量：只继承白名单前缀匹配的 + 额外指定的变量。
 *
 * U3 薄封装化（docs/architecture/env-propagation-boundary.md §5-U3）：过滤/extras 循环体由
 * shared 构建器的基座组装层承担，本函数只锚定 B2 边界的两个入参形态——parentEnv =
 * 本进程 env 快照（只读副本），prefixes = SSOT + ELECTRON_；「undefined = 显式删除」
 * 语义由构建器 extras 步骤原样承接（dev 清理 shell 残留 PACKAGED 标志的行为不变）。
 *
 * 【为何走 composeChildEnvBase 而非 buildOutboundChildEnv】deny 兜底治理的是「出产品
 * 边界」，而 B2（main→runtime）是产品内部边界：process-control 注入的 XYZ_AGENT_PACKAGED /
 * XYZ_RUNTIME_TOKEN 正是 runtime 进程自身的合法输入（isPackaged() 六处判定 + WS 鉴权
 * 消费），直调含 deny 的完整构建器会在打包态剥掉它们 → isPackaged() 恒 false、应用瘫痪。
 * 出站 deny 由下游对外边界（runtime→pi 等）的接线点承担。
 *
 * @param extras 额外注入的变量（undefined 值会被跳过；对应键已从白名单基座中显式删除）
 * @returns 精简后的 env 对象
 */
export function buildSafeEnv(extras: Record<string, string | undefined>): Record<string, string> {
  return composeChildEnvBase({ parentEnv: process.env, extras, prefixes: ENV_WHITELIST })
}
