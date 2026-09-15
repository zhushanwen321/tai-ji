/**
 * Terminal 配置读写 helper（从 config-service.ts 抽出，控 max-lines 500）。
 *
 * 职责：~/.taiji/terminal.json 的读写（独立文件，不复用 config.json）+
 * shell/字体/scrollback 等终端偏好的写入期校验。仅对新 spawn 的 PTY 生效
 *（已启动的 PTY 不动态切换 shell），由 TerminalService.resolveShell 读取。
 *
 * 抽出原因：config-service.ts 超 ESLint max-lines(500)。本模块含 terminal
 * 相关方法，移到本模块后 ConfigService 仅保留单行委托，行为 / 签名 / import 路径零变化
 *（复用 worktree-config-helper 的 accessors 注入模式，纯函数经 configDir 参数注入）。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TerminalConfig } from '@taiji/shared'
import { atomicWrite } from '../utils/fs-utils.js'
import { defaultTerminalConfig, mergeTerminalConfig } from './config-merge-helpers.js'
import {
  JSON_INDENT,
  uniqueTmpSuffix,
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
  SCROLLBACK_MAX,
} from './app-config-store.js'

/** terminal.json 路径（configDir 经参数注入，原 ConfigService.terminalPath 逐字搬迁）。 */
function terminalPath(configDir: string): string {
  return join(configDir, 'terminal.json')
}

/**
 * 读取 terminal.json。文件不存在返回默认配置（corrupted:false）；JSON 损坏返回默认配置（corrupted:true）。
 * 纯函数：configDir 经参数注入（原 ConfigService.getTerminalConfig 逐字搬迁）。
 */
export function getTerminalConfig(configDir: string): { config: TerminalConfig; corrupted: boolean } {
  const tp = terminalPath(configDir)
  if (!existsSync(tp)) {
    return { config: defaultTerminalConfig(), corrupted: false }
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(tp, 'utf-8'))
  } catch {
    return { config: defaultTerminalConfig(), corrupted: true }
  }
  return { config: mergeTerminalConfig(raw), corrupted: false }
}

/**
 * 写入 terminal.json。校验失败（fontSize/scrollback/cursorStyle 越界）返回 ok:false + error，不写盘。
 * 纯函数：configDir 经参数注入（原 ConfigService.setTerminalConfig 逐字搬迁）。
 */
export function setTerminalConfig(configDir: string, config: TerminalConfig): { ok: boolean; error?: string } {
  // 校验数值字段的合理范围（防异常值写盘后破坏 xterm 渲染或终端启动）
  if (!Number.isFinite(config.fontSize) || config.fontSize < FONT_SIZE_MIN || config.fontSize > FONT_SIZE_MAX) {
    return { ok: false, error: `fontSize out of range (${FONT_SIZE_MIN}-${FONT_SIZE_MAX}): ${config.fontSize}` }
  }
  if (!Number.isFinite(config.scrollback) || config.scrollback < 0 || config.scrollback > SCROLLBACK_MAX) {
    return { ok: false, error: `scrollback out of range (0-${SCROLLBACK_MAX}): ${config.scrollback}` }
  }
  const validCursorStyles: TerminalConfig['cursorStyle'][] = ['block', 'underline', 'bar']
  if (!validCursorStyles.includes(config.cursorStyle)) {
    return { ok: false, error: `invalid cursorStyle: ${config.cursorStyle}` }
  }
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true })

  // 用唯一 tmp 后缀避免并发 setTerminalConfig 撞固定 .tmp 文件（同 setSystemPromptConfig）
  atomicWrite(
    terminalPath(configDir),
    JSON.stringify(config, null, JSON_INDENT),
    uniqueTmpSuffix(),
  )
  return { ok: true }
}
