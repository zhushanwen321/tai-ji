/**
 * useCompletionSound —— 系统原生提示音播放（经 main 进程 IPC）。
 *
 * 原实现是 Web Audio 合成（OscillatorNode），现改为调用各平台原生系统声音：
 * - macOS：afplay /System/Library/Sounds/<name>.aiff
 * - Windows：main 读 C:\Windows\Media\<name>.wav 返 base64，renderer new Audio() 播
 * - Linux：paplay / pw-play / aplay /usr/share/sounds/freedesktop/stereo/<name>.oga
 *
 * 为什么走 main 进程：
 * - sandbox renderer 不能 fs 读 /System/Library/Sounds
 * - Chromium 不支持 macOS .aiff 格式
 * - Linux .oga + file:// 沙箱受限
 *
 * 平台默认声音映射 SSOT 在 @taiji/shared（sound-defaults.ts），
 * main 与 renderer 共享同一份（W4 去重）。
 */
import { getDefaultSound, detectPlatform } from '../sound-platform'
import { playSystemSound } from '@/lib/ipc'

/** playSystemSound 返回类型（win 返 wav base64，mac/linux 无） */
interface SoundPlayResult {
  audioData?: string
  mimeType?: string
}

// ── 默认音解析缓存（Q1-3）：detectPlatform 已在 sound-platform 侧 memo，
// 此处再缓存「kind → 平台默认音名」，连续播放不再重复解析。preferred 非空时直传，无需缓存。 ──
// taste:allow-no-data-owner W24-EX-C（非 GUI 数据技术结构，登记草稿）：kind→平台默认音名解析缓存（纯性能缓存，非 GUI 数据）
const defaultNameByKind = new Map<'success' | 'error', string>()

/**
 * win 平台 Audio 复用（Q1-3）：同音重播不重复 new Audio（base64 data URI 每次解码
 * 重建开销无意义）。按音名缓存；main 返回的 data URI 变化时重建（防御音文件更新）。
 */
// taste:allow-no-data-owner W24-EX-C（非 GUI 数据技术结构，登记草稿）：Audio 对象复用池（同音重播不重建，非 GUI 数据）
const audioBySound = new Map<string, { uri: string; audio: HTMLAudioElement }>()

function getOrCreateAudio(name: string, uri: string): HTMLAudioElement {
  const hit = audioBySound.get(name)
  if (hit && hit.uri === uri) return hit.audio
  const audio = new Audio(uri)
  audioBySound.set(name, { uri, audio })
  return audio
}

/** 测试专用：清空解析/Audio 缓存（测试隔离用）。 */
export function __resetSoundCachesForTest(): void {
  defaultNameByKind.clear()
  audioBySound.clear()
}

/**
 * 按名字播放系统提示音。
 * name 为空或未知时，main 侧 resolve 空结果（静默 no-op）。
 * win 返回 audioData（base64）时，用缓存的 Audio 对象播 wav（Chromium 原生支持）。
 *
 * @param name 实际播放的声音名
 * @param kind 逻辑分类（成功/失败），用于 main 侧跨平台失效时回落到对应平台默认（W3）。
 *             试听场景（已知声音）可不传。
 *
 * 防抖责任：本函数不做防抖。完成提示音场景由调用方 useCompletionNotify 负责（1s 模块级
 * 防抖，handleCompletion）；试听场景由 SoundPreviewButton 的 previewingKey 防重入。
 * 若未来有新调用方，需自行决定是否在调用点防抖（mac/linux spawn 多次会叠加播放）。
 */
export async function playByName(name: string, kind?: 'success' | 'error'): Promise<void> {
  // 经 lib/ipc 门面（B1）：web/mock 环境无 IPC 时 playSystemSound 返回空对象，下方 audioData 判空跳过。
  try {
    const result: SoundPlayResult = await playSystemSound(name, kind)
    // win32 路径：main 返 wav base64，renderer 播（Q1-3：Audio 按音名复用）
    if (result.audioData && result.mimeType) {
      const uri = `data:${result.mimeType};base64,${result.audioData}`
      const audio = getOrCreateAudio(name, uri)
      // 从头重播：暂停态续播会从中断处继续，重置到起点。
      // readyState >= 1（HAVE_METADATA）才赋值 currentTime：HAVE_NOTHING 时赋值是设置
      // default playback start position（不重置、也不抛），语义不是「回到起点」——守卫
      // 替代原 try/catch best-effort（无异常可捕获，赋值时机本身就是判据）。
      if (audio.readyState >= 1) {
        audio.currentTime = 0
      }
      void audio.play().catch(() => {
        // autoplay policy 拒绝时静默（后台完成场景，用户已交互过通常不会拒）
      })
    }
    // mac/linux 由 main spawn 播，此处无返回值
  } catch (err) {
    // 提示音失败不阻塞对话流
    console.error('[sound] playByName failed:', err)
  }
}

/**
 * 解析实际要播放的声音名：传入名优先，空则用平台默认。
 * 跨平台失效兜底由 main 侧处理（W3）：若传入名在当前平台不存在，main 回落到对应平台默认。
 * Q1-3：平台默认音按 kind memo（detectPlatform 自身已 memo）。
 */
function resolveName(preferred: string | undefined, kind: 'success' | 'error'): string {
  if (preferred && preferred.trim()) return preferred
  let name = defaultNameByKind.get(kind)
  if (name === undefined) {
    name = getDefaultSound(detectPlatform(), kind)
    defaultNameByKind.set(kind, name)
  }
  return name
}

/**
 * 播放成功提示音。
 * @param soundName 用户设置的声音名（undefined 用平台默认）
 */
export async function playSuccess(soundName?: string): Promise<void> {
  await playByName(resolveName(soundName, 'success'), 'success')
}

/**
 * 播放失败提示音。
 * @param soundName 用户设置的声音名（undefined 用平台默认）
 */
export async function playError(soundName?: string): Promise<void> {
  await playByName(resolveName(soundName, 'error'), 'error')
}

/**
 * useCompletionSound composable（函数式封装，便于 vitest mock 整个模块）。
 * 返回 { playSuccess, playError }，与直接 import 同名函数等价。
 */
export function useCompletionSound() {
  return { playSuccess, playError }
}
