/**
 * features/composer 模块入口 —— ui 包 composer 展示组件公共面（W4 composer-shell-integration）。
 *
 * 定位：p3-strangler-domains::composer W4 产物。ComposerInput 从 renderer components/panel
 * 迁移到 ui 包（props/emits/expose 契约不变，C1 契约），经 @taiji/ui/features/composer
 * 子路径暴露（对齐 ./rendering-protocol / ./extension-host 子路径范式）。
 *
 * deps 注入契约（clarify C1）：ui 包零 renderer import，pasteImage/renderIcon/t 三壳层
 * 能力经 ComposerInputDeps inject token 注入（renderer 壳 Composer.vue provide）。
 */
export { default as ComposerInput } from './ComposerInput.vue'
export { ComposerInputDepsKey, useComposerInputDeps } from './composer-input-deps'
export type { ComposerInputDeps } from './composer-input-deps'
