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
import { quarantineCorruptFile } from '../utils/json-store.js'

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

// ── 损坏降级态（code-harden M4 / RT-7#1）────────────────────────────
//
// config.json 损坏（JSON 畸形 / 顶层非对象）时的语义链：读侧 quarantineCorruptFile
// 隔离保现场 + 置降级标志 → save 侧拒绝以空骨架覆写（返回错误而非静默成功）→
// 原位文件恢复健康（成功解析出合法对象）时标志自愈清除。不隔离直接回 {} 的旧语义
// 会让紧随的任一 setter 全量覆写 config.json——用户全部偏好不可逆丢失（审计判定
// 本仓唯一会造成用户数据不可逆丢失的缺陷族，与 pi-presets.json / models.json 同批修复）。

/** saveAppConfig 失败码（RPC error envelope 的 code，经 config-service setter 透传到 renderer）。 */
export type SaveAppConfigErrorCode = 'app_config_corrupted' | 'app_config_io_error'

/** 诊断日志里的损坏内容截断长度（对齐 provider-extras-store 的 SCHEMA_SNIPPET_MAX 家族形态）。 */
const SCHEMA_SNIPPET_MAX = 120

/** saveAppConfig 结果（对齐 setSystemPromptConfig / setTerminalConfig 的 {ok, error} 形态，增补 code）。 */
export interface SaveAppConfigResult {
  ok: boolean
  /** 失败原因码：app_config_corrupted = 损坏降级态拒绝覆写；app_config_io_error = 落盘 IO 失败。 */
  code?: SaveAppConfigErrorCode
  /** 失败详情（含恢复动作指引，直传 error envelope message）。 */
  error?: string
}

/** 降级态登记（key = configDir）。quarantinePath 供错误消息指明取证副本入口。 */
const corruptedConfigDirs = new Map<string, { quarantinePath: string | undefined }>()

/**
 * 读取 app config.json（不存在返回 {}；损坏 → quarantine 隔离 + 置降级标志后返回 {}）。
 * 纯函数：configDir 经参数注入（原 ConfigService.loadAppConfig 逐字搬迁，this.appConfigPath() → join(configDir, 'config.json')）。
 */
export function loadAppConfig(configDir: string): Record<string, unknown> {
  const cp = join(configDir, 'config.json')
  try {
    if (existsSync(cp)) {
      const raw = readFileSync(cp, 'utf-8')
      const parsed = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        // 健康读取：清除降级态（用户已从 .corrupt 副本手工恢复的场景）
        corruptedConfigDirs.delete(configDir)
        return parsed as Record<string, unknown>
      }
      const quarantinePath = quarantineCorruptFile(cp, {
        tag: 'config-service',
        reason: 'top-level is not a JSON object',
        cause: new Error(`unexpected shape: ${JSON.stringify(parsed).slice(0, SCHEMA_SNIPPET_MAX)}`),
      })
      corruptedConfigDirs.set(configDir, { quarantinePath })
      console.error('[config-service] config.json is not a valid object, quarantined')
    }
  } catch (e) {
    // 解析失败 = 损坏：隔离保现场 + 置降级标志（下一次 save 拒绝空骨架覆写）。
    // existsSync 已过滤「尚无文件」的常态 ENOENT；本分支只会因真实损坏或极窄竞态进入。
    const quarantinePath = quarantineCorruptFile(cp, { tag: 'config-service', reason: 'parse failed', cause: e })
    corruptedConfigDirs.set(configDir, { quarantinePath })
    console.error('[config-service] load config.json error:', e)
  }
  return {}
}

/**
 * 全量覆写 app config.json（原子写 + mkdir 兜底）。
 * 降级态（config.json 已损坏隔离）下拒绝写入并返回错误——以「空骨架 + 本次字段」
 * 覆写会把用户其余全部偏好静默清空。纯函数：configDir 经参数注入。
 */
export function saveAppConfig(configDir: string, config: Record<string, unknown>): SaveAppConfigResult {
  const degraded = corruptedConfigDirs.get(configDir)
  if (degraded) {
    const copyRef = degraded.quarantinePath ?? `${join(configDir, 'config.json')}.corrupt-<ts>`
    return {
      ok: false,
      code: 'app_config_corrupted',
      error:
        `config.json 已损坏并被隔离（副本：${copyRef}），已拒绝本次写入以防空配置覆写。` +
        '恢复指引：对比 .corrupt 副本找回原配置写回 config.json 后重试',
    }
  }
  try {
    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true })
    // 用唯一 tmp 后缀避免并发 saveAppConfig 撞固定 .tmp 文件（同 setSystemPromptConfig）。
    atomicWrite(
      join(configDir, 'config.json'),
      JSON.stringify(config, null, JSON_INDENT),
      uniqueTmpSuffix(),
    )
    return { ok: true }
  } catch (e) {
    console.error('[config-service] save config.json error:', e)
    return {
      ok: false,
      code: 'app_config_io_error',
      error:
        `保存 config.json 失败：${e instanceof Error ? e.message : String(e)}。` +
        '恢复指引：检查磁盘空间/目录权限后重试',
    }
  }
}
