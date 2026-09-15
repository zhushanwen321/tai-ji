/**
 * usePlatformShortcut —— 跨平台快捷键显示符号格式化。
 *
 * 职责：把逻辑快捷键（如 'n' / 'shift+g'）转为平台对应的显示符号。
 * - mac：⌘N / ⌘⇧G（符号无分隔符）
 * - win/linux：Ctrl+N / Ctrl+Shift+G（单词 + 分隔符）
 *
 * 用 navigator.platform 判定，SSR/Electron renderer 环境均可用。
 * 判定结果在首次调用时缓存（navigator.platform 运行时不变）。
 *
 * 用法：
 * ```ts
 * const { formatKbd } = usePlatformShortcut()
 * formatKbd('n')        // mac→'⌘N', win→'Ctrl+N'
 * formatKbd('shift+g')  // mac→'⌘⇧G', win→'Ctrl+Shift+G'
 * formatKbd('k')        // mac→'⌘K', win→'Ctrl+K'
 * ```
 *
 * 统一收口：此前 Sidebar/Workspace/Overview/Turn 各自硬编码 ⌘，win/linux 显示错误。
 */
import { isMacPlatform } from '@/lib/platform'

export function usePlatformShortcut(): { formatKbd: (key: string) => string } {
  /**
   * 格式化快捷键为平台显示符号。
   * @param key 逻辑键名，如 'n' / 'k' / 'shift+g'（小写，无 mod 前缀，自动补全平台修饰键）
   * @returns 平台显示文本，mac 如 '⌘N'，win/linux 如 'Ctrl+N'
   */
  function formatKbd(key: string): string {
    const mac = isMacPlatform()
    const parts = key.toLowerCase().split('+')
    const result: string[] = []
    for (const p of parts) {
      if (p === 'shift') result.push(mac ? '⇧' : 'Shift')
      else if (p === 'alt') result.push(mac ? '⌥' : 'Alt')
      else result.push(p.toUpperCase())
    }
    // mac 符号无分隔符（⌘⇧G），win/linux 用 + 分隔（Ctrl+Shift+G）
    return `${mac ? '⌘' : 'Ctrl+'}${result.join(mac ? '' : '+')}`
  }

  return { formatKbd }
}
