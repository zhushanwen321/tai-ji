/**
 * index.ts —— RenderingProtocol 层 IF3 入口 facade（AC1 承载件）。
 *
 * 职责：把 extension-protocol 消费侧面 + 本模块 w1（custom-registry）/ w2（resolve）面
 * 聚合为单一入口，作为 @taiji/core/rendering-protocol 子路径的公共面。
 * 纯 re-export 零逻辑——降级/注册逻辑在 w1/w2 已落地，本文件只做接口收口。
 *
 * re-export 选型（clarify Q1 锁定）：
 * - 只 re-export goal 显式列出的 7 个 extension-protocol 符号（4 类型 + PROTOCOL_VERSION
 *   + extractGui + guiResult），**不 re-export 写侧 helper**（guiComponent/guiSetWidget/
 *   isGuiCapable/isGuiComponent/GUI_WIDGET_MARKER）。core 是消费/渲染侧（resolve = 读路径），
 *   re-export extension 写侧面会混淆 core 与 extension-protocol 的职责边界（§7.2）。
 * - 显式枚举每个符号（不用 `export *`），防 extension-protocol 未来新增符号悄悄漏到 core
 *   公共面（显式接口原则）。
 *
 * 类型与 runtime 分离（TC2「零运行时 vue / 零运行时 extension-protocol helper」延续）：
 * - `export type {}` 编译期擦除，产物零 extension-protocol helper 引用
 * - `export {}` runtime re-export 只含消费侧必需的 PROTOCOL_VERSION + extractGui + guiResult
 *
 * 依赖：w1（custom-registry.ts，closed）+ w2（resolve.ts，closed commit 558491e22）。
 */
// ── extension-protocol 消费侧面（goal 显式 7 符号）──
export type {
  GuiComponent,
  GuiComponentType,
  GuiComponentProps,
  GuiRenderResult,
} from '@zhushanwen/extension-protocol'

export { PROTOCOL_VERSION, extractGui, guiResult } from '@zhushanwen/extension-protocol'

// ── 本模块 w2 resolve 面 ──
export { resolveComponent } from './resolve'
export type { ResolvedRender } from './resolve'

// ── 本模块 w1 custom-registry 面 ──
export { GUI_CUSTOM_REGISTRY_KEY, EMPTY_CUSTOM_REGISTRY, isCustomRegistered } from './custom-registry'
