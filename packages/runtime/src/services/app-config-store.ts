/**
 * App config.json 读写 + 共享常量（从 config-service.ts 抽出，控 max-lines 500）。
 *
 * 职责：~/.taiji/config.json 的 load/save（原子写）+ JSON 序列化缩进 +
 * atomicWrite 唯一 tmp 后缀生成 + Terminal 校验常量。这些是其他 config helper
 *（system-prompt / terminal / worktree）的依赖基础，抽出后 ConfigService 仅保留
 * 单行委托，行为 / 签名 / import 路径零变化（复用 worktree-config-helper 模式）。
 *
 * 纯函数模块：不持有 ConfigService 实例引用，所有路径经 configDir 参数注入，
 * 避免暴露 ConfigService 的私有方法可见性 + 避免循环依赖。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWrite } from '../utils/fs-utils.js'

/** JSON 序列化缩进（saveAppConfig / setSystemPromptConfig / setTerminalConfig 的 atomicWrite 共用）。 */
export const JSON_INDENT = 2

/** Terminal config 校验范围（setTerminalConfig 写入期校验，与 TerminalPage 前端一致）。 */
export const FONT_SIZE_MIN = 6
export const FONT_SIZE_MAX = 72
export const SCROLLBACK_MAX = 100000

/**
 * 生成 atomicWrite 的唯一 tmp 后缀（时间戳 + 随机串），避免并发写入撞固定 .tmp 文件。
 * saveAppConfig / setSystemPromptConfig / setTerminalConfig 共用。
 */
export function uniqueTmpSuffix(): string {
  // eslint-disable-next-line no-magic-numbers -- base36 radix + slice 掉 "0." 前缀（惯用唯一串生成）
  return `${Date.now()}_${Math.random().toString(36).slice(2)}`
}

/**
 * 读取 app config.json（不存在 / 损坏返回 {}）。
 * 纯函数：configDir 经参数注入（原 ConfigService.loadAppConfig 逐字搬迁，this.appConfigPath() → join(configDir, 'config.json')）。
 */
export function loadAppConfig(configDir: string): Record<string, unknown> {
  try {
    const cp = join(configDir, 'config.json')
    if (existsSync(cp)) {
      const raw = readFileSync(cp, 'utf-8')
      const parsed = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
      console.error('[config-service] config.json is not a valid object, ignoring')
    }
  // eslint-disable-next-line taste/no-silent-catch -- intentional: config file missing/corrupt is handled by fallback
  } catch (e) {
    console.error('[config-service] load config.json error:', e)
  }
  return {}
}

/**
 * 全量覆写 app config.json（原子写 + mkdir 兜底）。
 * 纯函数：configDir 经参数注入（原 ConfigService.saveAppConfig 逐字搬迁）。
 */
export function saveAppConfig(configDir: string, config: Record<string, unknown>): void {
  try {
    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true })
    // 用唯一 tmp 后缀避免并发 saveAppConfig 撞固定 .tmp 文件（同 setSystemPromptConfig）。
    atomicWrite(
      join(configDir, 'config.json'),
      JSON.stringify(config, null, JSON_INDENT),
      uniqueTmpSuffix(),
    )
  // eslint-disable-next-line taste/no-silent-catch -- intentional: save failure is best-effort
  } catch (e) {
    console.error('[config-service] save config.json error:', e)
  }
}
