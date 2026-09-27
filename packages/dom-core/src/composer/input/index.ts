/**
 * composer input 模块入口 —— @taiji/dom-core/src/composer/input/ 的公开 API 聚合。
 *
 * 定位：ADR-0058 首批迁移（从 core/domain/composer/input/ 整体迁入，8 源 + 3 测试）。
 * useContenteditableInput + useComposerChipCommands + useComposerRestore + useComposerHistory +
 * useComposerDragDrop 五个 composable + input-dom.ts DOM 收敛层。
 *
 * 公开 API（5 composable + DOM 辅助函数 + 类型）：
 * - useContenteditableInput：contenteditable 输入组合逻辑（委托 input-dom）
 * - useComposerChipCommands：chip DOM 创建/删除（renderIcon/t 注入）
 * - useComposerRestore：发送后清空/失败恢复
 * - useComposerHistory：历史导航状态机（getHistoryEntries 注入，per-session 经 useSessionScopedState）
 * - useComposerDragDrop：拖拽落位（pasteImage 注入）
 * - getSegmentsFromEl/findImageChipEl/findImageChipElById：DOM 辅助（外部消费）
 *
 * deps 注入契约：所有跨域能力（IPC pasteImage / chatStore getHistoryEntries /
 * 图标渲染 renderIcon / i18n t）经 deps 回调注入，dom-core 零 renderer import、零 vue render
 * （ADR-0058 边界：DOM API only）。
 */
export { useContenteditableInput } from './contenteditable'
export { useComposerChipCommands } from './chip-commands'
export { useComposerRestore } from './restore'
export { useComposerHistory } from './history'
export { useComposerDragDrop } from './dragdrop'

// DOM 辅助函数（外部消费：ContextChipsBar 删除回调用 findImageChipElById，send 链路用 getSegmentsFromEl）
export {
  getSegmentsFromEl,
  getTextFromEl,
  detectHashTriggerFromEl,
  detectFileDollarTriggerFromEl,
  detectSubagentTriggerFromEl,
  detectSlashTriggerFromEl,
  moveCaretVerticalOf,
  pickClipboardImageItem,
  findImageChipEl,
  findImageChipElById,
  isSpacerNode,
  placeCursorAfter,
  removeChipNode,
  CHIP_SPACER_ZWSP,
} from './input-dom'

// 类型（外部消费：壳层 ComposerInput 组装 deps、W3 dispatch 消费 ComposerInputInstance）
export type {
  ContenteditableCallbacks,
  ChipCallbacks,
  ComposerInputInstance,
  ComposerRestoreDeps,
  DraftStore,
  HistoryDeps,
  DragDropDeps,
  ComposerNavState,
  HandleImagePasteResult,
  VerticalMoveResult,
} from './types'
