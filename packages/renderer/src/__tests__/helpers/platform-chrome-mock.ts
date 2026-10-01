/**
 * usePlatformChrome 测试 mock（TrafficLight.test.ts 与 app-shell-topology.test.ts 共享范式）。
 *
 * 真实模块 isFullscreen 是模块级单例 ref 未导出，测试无法直接改值，故 mock 模块。
 * vi.hoisted 共享同一 ref——mock 若不共享，组件读到的恒为 false，测试会在两类全缺失下
 * 静默通过。detectPlatform 默认 'mac'（jsdom/happy-dom 下真实模块也回退 'mac'）。
 */
import { vi, expect } from 'vitest'
import type { DOMWrapper } from '@vue/test-utils'

export type DetectPlatform = 'mac' | 'win' | 'linux'

/** 共享 mock 态（单例；isFullscreen 由 install 换装为真 ref，测试经同一引用改值）。 */
export const platformChromeMock = {
  isFullscreen: { value: false } as { value: boolean },
  detectPlatform: vi.fn<() => DetectPlatform>(() => 'mac'),
}

/** vi.mock factory：用共享态装配被 mock 模块（detectDefault = 该测试文件的默认平台）。 */
export async function installPlatformChromeMock(detectDefault: DetectPlatform): Promise<Record<string, unknown>> {
  const { ref } = await import('vue')
  const isFullscreen = ref(false)
  platformChromeMock.isFullscreen = isFullscreen
  platformChromeMock.detectPlatform.mockReturnValue(detectDefault)
  return {
    usePlatformChrome: () => ({ isFullscreen }),
    detectPlatform: platformChromeMock.detectPlatform,
  }
}

/**
 * 全屏 chrome 类成对断言（review MF-1 防隐形劫持）：opacity-0 与 pointer-events-none
 * 必须同进退——只隐藏视觉不关命中会让隐形圆点（absolute z-10）在折叠+全屏下重新劫持
 * 窗口控制点击。setFullscreen 注入本文件的态写入 + 视图刷新（nextTick/flushPromises）。
 */
export async function expectFullscreenChromePairing(
  tl: DOMWrapper<Element>,
  setFullscreen: (v: boolean) => Promise<void>,
): Promise<void> {
  // 非全屏：两类均无（圆点可见且可点）
  expect(tl.classes()).not.toContain('opacity-0')
  expect(tl.classes()).not.toContain('pointer-events-none')

  // 全屏：两类必须成对出现
  await setFullscreen(true)
  expect(tl.classes()).toContain('opacity-0')
  expect(tl.classes()).toContain('pointer-events-none')

  // 退出全屏：成对消失，恢复可交互
  await setFullscreen(false)
  expect(tl.classes()).not.toContain('opacity-0')
  expect(tl.classes()).not.toContain('pointer-events-none')
}
