/**
 * ui-preferences.json 读写 helper（跨进程 locale 通道 u-locale-channel）。
 *
 * 职责：`<dataDir>/ui-preferences.json` 的读写——renderer 经 `config.setUiLocale` RPC 上报
 * UI 语言，runtime 落盘后由 extension 侧就地读取（scheduler `readUiLocale`，u-p2a）热生效。
 *
 * 磁盘结构（<200 字节、非累积覆盖写）：
 *   { "v": 1, "locale": "zh-CN" | "en-US", "updatedAt": <epoch ms> }
 *
 * 路径经 `configService.getConfigDir()` 推导（= shared `getDataDir()`，读 `TAIJI_AGENT_DATA_DIR`，
 * 缺省 `~/.taiji-dev`——fail-safe default，C-proc-26；prod `~/.taiji` 仅打包 main 显式钉死可达），
 * 禁硬编码（数据目录隔离 ADR-0009；dev/多实例按各自 `<dataDir>` 天然隔离）。
 *
 * 原子写：tmp + rename（`utils/fs-utils` 的 `atomicWrite`，同 `system-prompt-config-helper.ts`
 * 范式），崩溃不留损坏中间态（ADR-0004）。
 *
 * 读侧容错（登记见 docs/architecture/data-source-registry.md 的 ui-preferences 行）：
 * - 文件缺失 → 静默回落默认 `en-US`（合法未写入态，不 warn）；
 * - JSON 损坏 / locale 非法 / 顶层非对象 → 回落默认 `en-US` + warn（手改或半写现场留痕）。
 *
 * 同值短路（两道分工）：第一道 = renderer `useSettingsShell.pushUiLocale` 的「上次已推送值」守卫
 * （外观/字号变更不推送语言，避免无谓 RPC）；第二道 = 本 helper（值未变不重写）——容忍其他
 * 调用方高频推送，且避免无谓刷新 mtime 使 extension 侧 mtime+size 缓存失效（多余失效会白读盘）。
 *
 * 多窗口同 app = last-write-wins（最后切换语言的窗口权威）：写路径单点、无跨窗广播，
 * 本文件只有 runtime 写（renderer 是客户端），不构成跨进程共享写面（不进 ADR 跨进程锁表）。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { UiLocale } from '@taiji/shared'
import { atomicWrite } from '../utils/fs-utils.js'
import { JSON_INDENT, uniqueTmpSuffix } from './app-config-store.js'

/** 读侧缺省值：文件缺失/损坏时回落（extension 侧现状本就是英文文案，故默认 `en-US`）。 */
export const DEFAULT_UI_LOCALE: UiLocale = 'en-US'

/** 实体文件名（与 `<dataDir>/config.json` / `system-prompt.json` 同级）。 */
const UI_PREFERENCES_FILE = 'ui-preferences.json'

/** 磁盘结构版本（v1；未来不兼容升级时递增，读侧只认已知版本语义）。 */
const UI_PREFERENCES_VERSION = 1

/** `ui-preferences.json` 绝对路径（configDir 经参数注入，便于测试用 tmp 目录）。 */
export function uiPreferencesPath(configDir: string): string {
  return join(configDir, UI_PREFERENCES_FILE)
}

/** 运行时收窄：wire / 磁盘值都不是可信来源（协议类型不保证外部字节）。 */
function isUiLocale(value: unknown): value is UiLocale {
  return value === 'zh-CN' || value === 'en-US'
}

/**
 * 读取当前 UI 语言。文件缺失 → 静默回落；损坏/非法 → 回落 + warn。
 */
export function readUiPreferences(configDir: string): UiLocale {
  const path = uiPreferencesPath(configDir)
  if (!existsSync(path)) return DEFAULT_UI_LOCALE
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (e) {
    console.warn(`[ui-preferences] ${UI_PREFERENCES_FILE} JSON 损坏，回落默认 locale ${DEFAULT_UI_LOCALE}`, e)
    return DEFAULT_UI_LOCALE
  }
  const locale = typeof raw === 'object' && raw !== null ? (raw as { locale?: unknown }).locale : undefined
  if (!isUiLocale(locale)) {
    console.warn(`[ui-preferences] ${UI_PREFERENCES_FILE} locale 非法（${String(locale)}），回落默认 ${DEFAULT_UI_LOCALE}`)
    return DEFAULT_UI_LOCALE
  }
  return locale
}

/**
 * 写入 UI 语言（tmp + rename 原子写）。返回 `{ ok:true }` 或 `{ ok:false, code, error }`——
 * 与偏好组 set case 的 `replySaveResult` 契约一致（失败由 handler 走 D10 错误信封，不假成功）。
 */
export function writeUiPreferences(
  configDir: string,
  locale: UiLocale,
  now: number = Date.now(),
): { ok: boolean; code?: string; error?: string } {
  try {
    // 同值短路：值未变不重写（renderer 侧值守卫之外的第二道，容忍其他调用方高频推送）。
    if (readUiPreferences(configDir) === locale) return { ok: true }
    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true })
    const payload = { v: UI_PREFERENCES_VERSION, locale, updatedAt: now }
    atomicWrite(uiPreferencesPath(configDir), JSON.stringify(payload, null, JSON_INDENT), uniqueTmpSuffix())
    return { ok: true }
  } catch (e) {
    return { ok: false, code: 'ui_preferences_io_error', error: e instanceof Error ? e.message : String(e) }
  }
}
