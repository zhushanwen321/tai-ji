/**
 * 系统提示音 IPC handler（mac afplay / win wav 返 base64 / linux paplay）。
 *
 * 跨平台播放系统原生提示音。sandbox renderer 不能 fs 读系统声音目录，也播不了
 * macOS .aiff（Chromium 不支持），故全部下沉到 main 进程处理。
 *
 * 平台分发：
 * - darwin：spawn `afplay /System/Library/Sounds/<name>.aiff`（fire-and-forget，unref）
 * - win32：读 `C:\Windows\Media\<name>.wav` 为 base64 返回，renderer 用 `new Audio()` 播
 * - linux：spawn `paplay` / `pw-play` / `aplay`（探测存在性，按优先级 fallback）
 *
 * 安全：
 * - sound:play 的 name 必须在当前平台精选清单内（防借道 spawn 任意命令 / 读任意文件）
 * - 清单是模块级常量，不读用户输入构造路径
 *
 * 失败语义：播放失败 console.error 后 resolve（不 throw）——提示音失败不该打断对话流。
 *
 * 跨平台失效兜底（W3）：用户在 mac 选了具体音名（如 'Hero'），切到 linux 后该音不存在。
 * sound:play 收到 name + kind 时，isKnownSound 失败则回落到 DEFAULT_SUCCESS_PLATFORM[platform]
 * / DEFAULT_ERROR_PLATFORM[platform]，不再静默 no-op（完成提示音静默会让用户误以为没触发）。
 */
import { ipcMain } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import {
  DEFAULT_SUCCESS_PLATFORM,
  DEFAULT_ERROR_PLATFORM,
  type SoundKind,
  type SoundPlatform,
} from '@taiji/shared'

// ── 平台声音清单（精选，语义适合「完成提示」）──

/** macOS 系统声音根目录（Big Sur → Sequoia 稳定） */
const MAC_SOUND_DIR = '/System/Library/Sounds'
/** macOS 精选声音 id（= 文件名去 .aiff 后缀）。names 取系统原生名不翻译 */
const MAC_SOUNDS = [
  'Glass', 'Hero', 'Ping', 'Pop', 'Purr', 'Submarine', 'Morse', 'Funk',
] as const

/** Windows 系统声音目录（Win10/11，经典 tada/chimes 默认已移除，靠 existsSync 过滤） */
const WIN_SOUND_DIR = 'C:\\Windows\\Media';
/** Windows 精选声音 id（= 文件名去 .wav 后缀） */
const WIN_SOUNDS = [
  'Windows Notify System Generic',
  'Windows Notify Email',
  'Windows Notify Messaging',
  'Windows Background',
  'Windows Foreground',
  'chimes',
] as const

/** Linux freedesktop sound-theme 目录（需装 sound-theme-freedesktop） */
const LINUX_SOUND_DIR = '/usr/share/sounds/freedesktop/stereo';
/** Linux 精选声音 id（= 文件名去 .oga 后缀） */
const LINUX_SOUNDS = [
  'complete', 'message-new-instant', 'service-login', 'bell', 'window-attention', 'message',
] as const

/**
 * DEFAULT_SUCCESS_PLATFORM / DEFAULT_ERROR_PLATFORM SSOT 来自 @taiji/shared
 * （main 与 renderer 共享同一份字面量，消除双写——见 W4）。
 */

/** SoundInfo：id=播放用标识，name=显示名（不翻译，用系统原生名） */
export interface SoundInfo {
  id: string
  name: string
}

/** sound:list 返回类型 */
export interface SoundListResult {
  platform: string
  sounds: SoundInfo[]
}

/** sound:play 返回类型。win 有 audioData（base64）让 renderer 播，mac/linux 空对象 */
export interface SoundPlayResult {
  audioData?: string
  mimeType?: string
}

// ── 命令存在性探测（Linux 播放器 fallback 用）──

/**
 * 探测命令是否在 PATH：直接 spawn 该命令跑 `--version`，成功（exit 0）即存在。
 *
 * 跨平台：不依赖 shell builtin（旧实现用 POSIX `command -v` + shell:true，Windows 失效）。
 * `--version` 是 paplay/pw-play/aplay 共通的支持参数；某些命令对未知 flag 也 exit 0，
 * 但对不存在命令 spawnSync 会抛错或非零 exit，足够探测用途。
 */
function commandExists(cmd: string): boolean {
  try {
    const r = spawnSync(cmd, ['--version'], { stdio: 'ignore' })
    return r.status === 0
  } catch {
    return false
  }
}

/** Linux 播放器命令缓存（首次探测后记住，避免每次播放都 spawnSync） */
let linuxPlayerCmd: string | null | undefined

/** 返回可用的 Linux 播放器命令（paplay / pw-play / aplay 优先级），全部缺失返回 null */
function getLinuxPlayer(): string | null {
  if (linuxPlayerCmd !== undefined) return linuxPlayerCmd
  for (const cmd of ['paplay', 'pw-play', 'aplay']) {
    if (commandExists(cmd)) {
      linuxPlayerCmd = cmd
      return cmd
    }
  }
  linuxPlayerCmd = null
  return null
}

// ── 按平台列举可用声音（existsSync 过滤当前机器实际存在的）──

function listMacSounds(): SoundInfo[] {
  return MAC_SOUNDS
    .filter((id) => existsSync(join(MAC_SOUND_DIR, `${id}.aiff`)))
    .map((id) => ({ id, name: id }))
}

function listWinSounds(): SoundInfo[] {
  return WIN_SOUNDS
    .filter((id) => existsSync(join(WIN_SOUND_DIR, `${id}.wav`)))
    .map((id) => ({ id, name: id }))
}

function listLinuxSounds(): SoundInfo[] {
  return LINUX_SOUNDS
    .filter((id) => existsSync(join(LINUX_SOUND_DIR, `${id}.oga`)))
    .map((id) => ({ id, name: id }))
}

/** 按当前平台列举可用声音 */
function listForPlatform(platform: string): SoundListResult {
  switch (platform) {
    case 'darwin': return { platform, sounds: listMacSounds() }
    case 'win32': return { platform, sounds: listWinSounds() }
    case 'linux': return { platform, sounds: listLinuxSounds() }
    default: return { platform, sounds: [] }
  }
}

// ── 按平台播放 ──

/** 各平台精选清单查表（用于 isKnownSound 校验） */
const SOUND_LIST_BY_PLATFORM: Record<string, readonly string[]> = {
  darwin: MAC_SOUNDS,
  win32: WIN_SOUNDS,
  linux: LINUX_SOUNDS,
}

/** 受支持的平台（用于把 Node 的 Platform 收窄为 SoundPlatform） */
const KNOWN_PLATFORMS: readonly SoundPlatform[] = ['darwin', 'win32', 'linux']

/** 收窄 process.platform 为 SoundPlatform，未知平台返回 null */
function toSoundPlatform(p: string): SoundPlatform | null {
  return (KNOWN_PLATFORMS as readonly string[]).includes(p) ? (p as SoundPlatform) : null
}

/** 校验 name 在当前平台精选清单内（防借道） */
function isKnownSound(name: string, platform: SoundPlatform): boolean {
  return SOUND_LIST_BY_PLATFORM[platform].includes(name)
}

/**
 * macOS 播放：spawn afplay（fire-and-forget，unref 不阻塞主进程退出）。
 * afplay 是用户态命令，无沙箱限制，自己管理播放时长。
 * 文件不存在时记录警告并返回空对象（统一 existsSync 守卫，避免 spawn 不存在的路径
 * 导致 child.on('error') 静默吞错——见 S4）。
 */
function playMac(name: string): SoundPlayResult {
  const path = join(MAC_SOUND_DIR, `${name}.aiff`)
  if (!existsSync(path)) {
    console.warn(`[sound] sound file not found: ${name}`)
    return {}
  }
  const child = spawn('afplay', [path], { stdio: 'ignore', detached: true })
  child.on('error', (err) => console.error('[sound] afplay failed:', err))
  child.unref()
  return {}
}

/**
 * Linux 播放：探测 paplay/pw-play/aplay，spawn 后 unref。
 * 无可用播放器或声音文件不存在时返回空对象（统一 existsSync 守卫——见 S4，
 * 避免 spawn 不存在的路径让 child.on('error') 静默吞错）。
 */
function playLinux(name: string): SoundPlayResult {
  const cmd = getLinuxPlayer()
  if (!cmd) return {}
  const path = join(LINUX_SOUND_DIR, `${name}.oga`)
  if (!existsSync(path)) {
    console.warn(`[sound] sound file not found: ${name}`)
    return {}
  }
  const child = spawn(cmd, [path], { stdio: 'ignore', detached: true })
  child.on('error', (err) => console.error(`[sound] ${cmd} failed:`, err))
  child.unref()
  return {}
}

/**
 * Windows 播放：读 wav 为 base64 返回，由 renderer 用 new Audio() 播。
 * 不 spawn（PowerShell 重），wav 是 Chromium 原生支持格式。
 * 文件不存在时返回空对象（renderer 静默 no-op）。
 *
 * base64 缓存（S1）：试听场景连点多个声音对比时，同一声音重复读盘浪费 IO。
 * 模块级 Map 按 name 缓存（win32 路径唯一，key 用 name 即可），首次播放后命中。
 */
const winSoundBase64Cache = new Map<string, SoundPlayResult>()

function playWin(name: string): SoundPlayResult {
  const cached = winSoundBase64Cache.get(name)
  if (cached) return cached
  const path = join(WIN_SOUND_DIR, `${name}.wav`)
  if (!existsSync(path)) return {}
  try {
    const buf = readFileSync(path)
    const result: SoundPlayResult = { audioData: buf.toString('base64'), mimeType: 'audio/wav' }
    winSoundBase64Cache.set(name, result)
    return result
  } catch (err) {
    console.error('[sound] read wav failed:', err)
    return {}
  }
}

/**
 * 按 name + 平台分发播放。name 必须在精选清单内（调用方已校验）。
 */
function playByName(platform: SoundPlatform, name: string): SoundPlayResult {
  switch (platform) {
    case 'darwin': return playMac(name)
    case 'linux': return playLinux(name)
    case 'win32': return playWin(name)
    default: return {}
  }
}

/**
 * 注册系统提示音 IPC handler。
 *
 * - sound:list：返回当前平台可用声音清单（existsSync 过滤）
 * - sound:play：按平台分发播放。name 必须在精选清单内，否则按 kind 回落到平台默认（W3）；
 *   kind 缺省（试听未知声音）时静默 resolve 空结果（防借道）
 *
 * 幂等：开头 removeHandler 两个 channel，重复注册不抛
 * "Attempted to register a second handler"（B1）。removeHandler 对未注册 channel 不抛错，安全。
 */
export function registerSoundHandlers(): void {
  // B1：幂等保护——重复注册时先解绑旧 handler，避免 electron 抛 second handler 错误。
  // removeHandler 对未注册的 channel 是 no-op（不抛错），故首次调用也安全。
  ipcMain.removeHandler('sound:list')
  ipcMain.removeHandler('sound:play')

  ipcMain.handle('sound:list', (): SoundListResult => {
    return listForPlatform(process.platform)
  })

  ipcMain.handle('sound:play', (_event, name: string, kind?: SoundKind): SoundPlayResult => {
    const platform = toSoundPlatform(process.platform)
    if (!platform) return {} // 不支持的平台（freebsd/aix 等）静默 no-op
    // 安全校验：name 必须在当前平台精选清单内（防借道 spawn/read 任意路径）
    if (!name || !isKnownSound(name, platform)) {
      // W3 跨平台失效兜底：用户在 mac 选了 'Hero' 切到 linux，该音不存在。
      // 提供 kind 时回落到对应平台默认（不再静默——完成音静默会让用户误以为没触发）；
      // 无 kind（试听未知声音）时仍静默 resolve 空结果（防借道，且试听本就来自已过滤清单）。
      if (kind) {
        const fallback = kind === 'success'
          ? DEFAULT_SUCCESS_PLATFORM[platform]
          : DEFAULT_ERROR_PLATFORM[platform]
        console.warn(`[sound] unknown sound "${name}" on ${platform}, falling back to default ${kind}: ${fallback}`)
        try {
          return playByName(platform, fallback)
        } catch (err) {
          console.error('[sound] fallback play failed:', err)
          return {}
        }
      }
      console.warn('[sound] unknown sound name, ignored:', name)
      return {}
    }
    try {
      return playByName(platform, name)
    } catch (err) {
      // 播放失败不抛错：提示音是锦上添花，不该让对话流卡住
      console.error('[sound] play failed:', err)
      return {}
    }
  })
}
