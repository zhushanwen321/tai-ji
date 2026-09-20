/**
 * TAIJI_PLUGIN_PERMISSION_TIMEOUT_MS 读取（timeout-plugin-service D3）。
 *
 * 从 plugin-service.ts 迁出（max-lines 预算，行为逐字不变）：本函数是纯 env 解析，
 * 不依赖 PluginService 任何实例状态，独立模块无耦合代价。
 *
 * 权限审批等待的全局逃生门。合法正数生效；缺失/非法 warn 回落 undefined →
 * Activator 构造函数落 PERMISSION_TIMEOUT_MS（回落权威单一在构造函数，此处只解析 env）。
 *
 * 形态对齐 subagent-core lifecycle-manager getEnvIdleTimeoutMs 先例：「以为设了
 * 超长等待、实际回落默认」的静默语义漂移不可见，非法必须 warn 留痕。
 *
 * §11 检查点结论（C-proc-09 核对）：runtime 进程自读 env，不进任何白名单——
 * 入站方向 ENV_WHITELIST_PREFIXES（shared/constants.ts）已含裸 'TAIJI_' 前缀天然
 * 放行；出站方向 runtime 不向子进程注入该变量（消费点仅 runtime 自身），且
 * SPAWN_ENV_FORWARD_REFERENCE 为纯文档性登记不参与过滤（runtime 自身行为开关
 * 不登记，TAIJI_LOG_LEVEL 族 U0-② 同款结论）。
 */
import { PERMISSION_TIMEOUT_MS } from './plugin-activator.js'

export function readEnvPermissionTimeoutMs(): number | undefined {
  const raw = process.env.TAIJI_PLUGIN_PERMISSION_TIMEOUT_MS
  if (!raw) return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `[plugin-service] TAIJI_PLUGIN_PERMISSION_TIMEOUT_MS="${raw}" is invalid (expected a positive millisecond number) — falling back to default ${PERMISSION_TIMEOUT_MS}ms (30min); set a plain ms value (e.g. 1800000) to override`,
    )
    return undefined
  }
  return parsed
}
