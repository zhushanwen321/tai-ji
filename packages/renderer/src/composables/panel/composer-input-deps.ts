/**
 * ComposerInputDeps 共享装配器（user-bubble-edit-composer 落地件）。
 *
 * 背景：ComposerInput（ui 包 contenteditable 富编辑器）的三项壳层能力（粘贴图片落盘 IPC /
 * slash 图标渲染 / i18n）经 ComposerInputDepsKey inject 注入（ADR-0058 边界：dom-core 零
 * vue render / 零 IPC / 零 i18n）。此前只有 Composer.vue 一处 provide；用户气泡编辑态
 * （简化版 composer）复用同一 ComposerInput，需要同一份实现——提取为本 composable，
 * 两个宿主（底部 Composer / 消息流内编辑框）共用单点，杜绝第二份 renderIcon 实现漂移。
 *
 * 用法：组件 setup 内调 provideComposerInputDeps()（须在渲染 ComposerInput 之前）。
 * 渲染顺序无关性：inject 在子组件 setup 时解析，provide 在本组件 setup 同步执行即生效。
 */
import { createVNode, provide, render } from 'vue'
import { useI18n } from 'vue-i18n'
import { ComposerInputDepsKey, type ComposerInputDeps } from '@taiji/ui/features/composer'
import { handleImagePaste } from '@/composables/panel/useImageAttachment'
// renderer 侧薄 re-export（SSOT 在 @taiji/ui，见该文件头注）
import { SLASH_ICON_COMPONENTS } from '@/composables/slashIcons'

/** provide ComposerInputDepsKey（真实 renderer 实现）。两宿主共用，字段语义见 composer-input-deps.ts 契约。 */
export function provideComposerInputDeps(): void {
  const { t } = useI18n()
  const deps: ComposerInputDeps = {
    pasteImage: handleImagePaste,
    // renderIcon：图标查找 + vue render 内聚在壳层（dom-core 零 vue render，ADR-0058 边界）。
    // 返回 true = 已渲染图标（dom-core 侧挂载 host），false = 无图标不渲染。
    renderIcon: (host: HTMLElement, iconKey?: string) => {
      const Comp = iconKey
        ? SLASH_ICON_COMPONENTS[iconKey as keyof typeof SLASH_ICON_COMPONENTS]
        : undefined
      if (!Comp) return false
      render(createVNode(Comp, { size: 12 }), host)
      return true
    },
    t: (key: string) => t(key),
  }
  provide(ComposerInputDepsKey, deps)
}
