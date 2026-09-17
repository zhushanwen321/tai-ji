/**
 * pi extension ext-config 文件的共享 RMW 写基建（rename-session / smart-context 两个
 * 配置域共用）。
 *
 * 为什么独立成模块：rmwExtConfigField 是跨进程锁协议的载体（D1e，integrity-hardening
 * §3.1）——rename-session 与 smart-context 两个 ext-config 文件都被 runtime 与对应
 * pi extension 双方 RMW，锁协议要求两域「逐字同一实现」。放任一域文件都会让另一域
 * 反向依赖兄弟域的内部 helper（模块边界破坏）；复制两份则锁协议双源、漂移只是时间
 * 问题。故抽本模块作为唯一实现点。
 *
 * 契约对齐源：extension 侧 extensions/shared/llm-shared 的 loadConfig/saveConfig
 * （JSON 2 空格缩进 + 尾换行 + tmp 带 pid+随机段 + lockfile = 目标文件自身 + '.lock'）。
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { atomicWrite } from '../utils/fs-utils.js'
import { withFileLockSync, type SyncFileLockOptions } from '../utils/file-lock.js'

/** JSON 序列化缩进格数（与 extension 侧 llm-shared saveConfig 的 JSON_INDENT 一致）。 */
export const EXT_CONFIG_JSON_INDENT = 2

/** 并发唯一 tmp 后缀：pid + 36 进制随机段（rename-session / smart-context 两个 RMW 写点共用）。 */
export function extConfigTmpSuffix(): string {
  // 36 进制、跳过 "0." 前缀取 6 位，与 llm-shared uniqueTmpPath 同形态
  // eslint-disable-next-line no-magic-numbers -- tmp 随机段形态契约，见上行注释
  return `${process.pid}_${Math.random().toString(36).slice(2, 8)}`
}

/** 从原始 JSON 对象提取指定字段的 ref（仅认 {type:"ref", ref:string} 形态，其余返回空串）。 */
export function extractRefString(raw: Record<string, unknown>, field: string): string {
  const model = raw[field]
  if (typeof model !== 'object' || model === null || Array.isArray(model)) return ''
  const ref = (model as Record<string, unknown>)['ref']
  return typeof ref === 'string' ? ref : ''
}

/**
 * ext-config 文件 RMW 只覆盖指定字段（rename / smart-context 两个写点共用）：读文件 → 展开基底 →
 * apply 覆盖 → 原子写（2 空格缩进 + 尾换行，与 extension llm-shared saveConfig 序列化格式一致）。
 * 文件不存在/坏 JSON → defaultBase()（与 extension 读取侧的回退语义一致：坏文件本来就无效）。
 */
export function rmwExtConfigField(
  configPath: string,
  lockOptions: SyncFileLockOptions,
  defaultBase: () => Record<string, unknown>,
  apply: (base: Record<string, unknown>) => void,
): void {
  withFileLockSync(configPath, () => {
    let base: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf-8'))
      base = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? { ...(parsed as Record<string, unknown>) }
        : defaultBase()
    } catch {
      base = defaultBase()
    }
    apply(base)
    mkdirSync(dirname(configPath), { recursive: true })
    // tmp 唯一化：对端（extension llm-shared saveConfig）写同一文件，其 tmp 已带 pid+随机段；
    // 本侧留固定 .tmp 会与旧版对端碰撞（锁互斥下无害但脏残留），对齐同形态。
    atomicWrite(configPath, `${JSON.stringify(base, null, EXT_CONFIG_JSON_INDENT)}\n`, extConfigTmpSuffix())
  }, lockOptions)
}
