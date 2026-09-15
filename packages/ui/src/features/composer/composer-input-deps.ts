/**
 * ComposerInputDeps —— ui 包 ComposerInput 组件消费壳层依赖的唯一契约（W4 composer-shell-integration）。
 *
 * ui 包展示组件不直接 import renderer store/composable（反向依赖禁令），
 * 所有跨层依赖（IPC 图片落盘 / slash 图标映射 / i18n 文案）经此 inject token 注入。
 * renderer 壳层（Composer.vue）provide 真 renderer 实现。
 *
 * 设计依据：clarify C1 inject token 裁决（对齐 w6 ChatViewDeps 范式；props 契约不变
 * ——C1 契约仅 placeholder/disabled/sessionId 三字段，deps 不能走 props 扩展）。
 */
import type { InjectionKey } from 'vue'
import { inject } from 'vue'
import type { HandleImagePasteResult } from '@taiji/dom-core/composer/input'

/**
 * ComposerInput 依赖端口（shell → ui 展示层注入）。
 *
 * 三个字段与 core input 模块的 deps 注入契约一一对应（ContenteditableCallbacks.pasteImage /
 * ChipCallbacks.renderIcon / ChipCallbacks.t）：
 * - pasteImage：粘贴/拖入图片处理（走 writeSessionImage IPC 落盘，dom-core 不 import IPC）
 * - renderIcon：把 slash 命令 chip 图标渲染进宿主元素（SLASH_ICON_COMPONENTS 查找 + vue render，
 *   dom-core 零 vue render——ADR-0058 边界）
 * - t：i18n 文案（chip × 按钮 aria-label，dom-core 不 import i18n）
 */
export interface ComposerInputDeps {
  /** 粘贴/拖入图片处理（sessionId 为 null 时 IPC 内降级 tmpdir） */
  pasteImage: (file: File, sessionId: string | null) => Promise<HandleImagePasteResult>
  /**
   * 把 slash 命令图标渲染进宿主元素（iconKey 如 'terminal'/'star'/'wrench'）。
   * 返回 true 表示已渲染图标（调用方挂载 host），false 表示无图标不渲染。
   */
  renderIcon: (host: HTMLElement, iconKey?: string) => boolean
  /** 国际化文案（chip × 按钮 aria-label） */
  t: (key: string) => string
}

/** ComposerInputDeps inject token（InjectionKey 保类型安全） */
export const ComposerInputDepsKey: InjectionKey<ComposerInputDeps> = Symbol('ComposerInputDeps')

/**
 * inject ComposerInputDeps helper。token 缺失时抛错（防运行时 undefined 调用崩溃）。
 * ui 组件 setup 顶部调 const deps = useComposerInputDeps()。
 */
export function useComposerInputDeps(): ComposerInputDeps {
  const deps = inject(ComposerInputDepsKey)
  if (!deps) {
    throw new Error(
      '[ComposerInputDeps] inject 缺失：组件必须在 provide ComposerInputDepsKey 的容器内渲染。' +
        'renderer 壳层 Composer.vue 应 provide(ComposerInputDepsKey, realDeps)。',
    )
  }
  return deps
}
