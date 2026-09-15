/**
 * GUI custom 组件注册表的 provide/inject key（类型安全，防拼写漂移）。
 *
 * 从独立 .ts 文件导出（而非 <script setup> 内 export，后者被 Vue SFC 编译器禁止）。
 * GuiComponentRenderer inject 此 key，内置 extension 编译期 provide 自有组件（P2+ 实现）。
 *
 * 权威定义在 core（@taiji/core/rendering-protocol/custom-registry）——本文件仅转发，
 * 保证 renderer 消费方（@taiji/ui 根导出）、ui 包内部组件、core 三方拿到同一 Symbol
 * 实例（re-home 前 gui-registry.ts 单一 Symbol 语义；若在此重新定义 Symbol 会产生双 key，
 * builtin extension provide（core key）与渲染器 inject（本 key）断裂）。
 */
export { GUI_CUSTOM_REGISTRY_KEY } from '@taiji/core/rendering-protocol/custom-registry'
