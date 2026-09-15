/**
 * usePlatformChrome —— 平台 + 全屏态（shell spec §七-3/4）。
 *
 * 职责：
 * - 注入 `<html data-platform="mac|win|linux">`：CSS 平台分支依据
 *   （mac 系统画红黄绿 / win·linux 自绘圆点）
 * - 暴露 module-level 单例 isFullscreen ref：全屏态全局共享
 *   （TrafficLight opacity / AppNavControls left 两态变换消费它，spec §二）
 *
 * 平台判定：navigator.userAgent 字符串匹配（不新增 IPC，减少 main 改动）。
 * web/mock 环境无 electronAPI 时全屏监听优雅降级（isFullscreen 恒 false）。
 *
 * 依赖方向：读全局 window.electronAPI（lib/ipc 同源），无下游。
 */
import { onMounted, ref } from 'vue'
import type { Ref } from 'vue'
import { onFullscreenChanged } from '@/lib/ipc'

export type Platform = 'mac' | 'win' | 'linux'

/** 从 navigator.userAgent 判定平台（Electron 渲染进程内可用） */
export function detectPlatform(): Platform {
  const ua = navigator.userAgent
  if (ua.includes('Mac')) return 'mac'
  if (ua.includes('Win')) return 'win'
  if (ua.includes('Linux')) return 'linux'
  return 'mac' // fallback：开发机 mac
}

/**
 * 全屏态单例 ref：全应用共享（TrafficLight + AppNavControls 都读它）。
 * 初始 false；首次 usePlatformChrome 调用时注册 IPC 监听同步它。
 */
// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态，12 类未覆盖存量，登记草稿）：窗口全屏态 renderer 镜像（平台事件回写，12 类未覆盖）
const isFullscreen = ref(false)
let listening = false

/**
 * 在组件 setup 中调用：注入 data-platform + 绑定全屏监听（单例保护），返回 isFullscreen ref。
 * 必须在带生命周期的组件（AppShell / TrafficLight / AppNavControls）setup 同步调用。
 */
export function usePlatformChrome(): { isFullscreen: Ref<boolean> } {
  onMounted(() => {
    document.documentElement.setAttribute('data-platform', detectPlatform())
    if (!listening) {
      listening = true
      onFullscreenChanged((v) => {
        isFullscreen.value = v
      })
    }
  })
  return { isFullscreen }
}
