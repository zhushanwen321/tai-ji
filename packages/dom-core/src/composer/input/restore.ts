/**
 * composer 发送后清空 / 失败恢复的输入区状态操作 —— packages/dom-core/src/composer/input/restore.ts（W2）。
 *
 * 定位：迁自 renderer useComposerRestore.ts。职责单一：操作 draft ref + inputRef，完成三类副作用：
 * - clearInput：发送成功后清空（DOM + draft + 持久化草稿）
 * - restoreInput：发送失败恢复纯文本草稿
 * - restoreSegments：发送失败恢复 text + 各类 chip（W8 修复）
 *
 * 不含：发送 / steer / fork / 输入编辑（留 dispatch 模块 / 其他 composable）。
 * 纯逻辑编排，零 DOM 直连，零 renderer import。
 */
import type { Segment } from '@taiji/shared'
import type { ComposerInputInstance, ComposerRestoreDeps } from './types'

/**
 * segments 回填输入实例的最小目标面（ComposerInputInstance 的 Pick）。
 * restoreSegmentsIntoInput 只消费这 7 个成员；ui ComposerInput.setSegments（移动壳 D6
 * 草稿回填）以自身同名方法构造此结构调用，不必扮演完整实例契约。
 */
export type SegmentsRestoreTarget = Pick<
  ComposerInputInstance,
  | 'setText'
  | 'insertImageBadge'
  | 'insertSlashChip'
  | 'insertFileChip'
  | 'insertSessionChip'
  | 'insertSubagentChip'
  | 'insertSkillChip'
>

/**
 * segments 快照回填输入实例的唯一实现（W8 方案 A）：text 段 setText 重建纯文本，
 * 非 text 段按类型经 insert* 还原真 chip。
 *
 * 单一定义点：useComposerRestore.restoreSegments（桌面发送失败恢复）与 ui
 * ComposerInput.setSegments（移动壳 D6 发送失败草稿回填）共用——新增 chip 类型只改
 * 此处，双消费端同步获得回填能力（防第二定义点的静默缺口：桌面恢复了某类 chip、
 * 移动壳 setSegments 静默丢弃）。session/subagent/skill 三类经 ?. 调用（可选契约——
 * 低配实现缺省时静默跳过该类 chip，文字部分仍恢复，不崩溃）。
 */
export function restoreSegmentsIntoInput(input: SegmentsRestoreTarget, segments: Segment[]): void {
  const textOnly = segments
    .filter((s): s is Extract<Segment, { type: 'text' }> => s.type === 'text')
    .map((s) => s.text)
    .join('')
  input.setText(textOnly)
  for (const seg of segments) {
    if (seg.type === 'image') {
      input.insertImageBadge(seg.path, seg.fileName, seg.displayName, seg.needsMigrate ?? false)
    } else if (seg.type === 'slash') {
      // 命令 chip 形态恢复（设计 D4/D6）：insertSlashChip(name) 重建命令 chip（name 不含
      // '/' 前缀，insertSlashChip 内部归一化补回），内部仅替换已有命令 chip 不误删 skill
      // chip；回滚位置近似=尾部、不保序（D6 登记边界，与其他 chip 类同）
      input.insertSlashChip(seg.name)
    } else if (seg.type === 'skill') {
      // skill chip 恢复走 insertSkillChip 通路（设计 D3 同修）：光标处追加 + location 透传，
      // 不再走 insertSlashChip（其会误删其他 slash-chip、强制最前、且丢 location）。
      input.insertSkillChip?.(seg.name, seg.location)
    } else if (seg.type === 'file') {
      input.insertFileChip(seg.path, seg.lineRange)
    } else if (seg.type === 'session') {
      // session 引用 chip 恢复（# session，U1）：label 展示 + sessionId 落 dataset（getSegments 重建 segment 用）
      input.insertSessionChip?.(seg.sessionId, seg.label)
    } else if (seg.type === 'subagent') {
      // subagent 定向 chip 恢复（@ subagent，U2b）：subagentId/slug 原样回填（占位新建
      // chip subagentId 为空串，回填后再次发送仍走 start 分流，语义不变）
      input.insertSubagentChip?.(seg.subagentId, seg.slug)
    }
  }
}

/**
 * @param deps draft / inputRef / drafts / sessionId 四项依赖（Composer.vue 内定义后注入）
 */
export function useComposerRestore(deps: ComposerRestoreDeps) {
  /** 发送成功后清空输入区（DOM + draft + 持久化草稿） */
  function clearInput(): void {
    deps.draft.value = ''
    const sid = deps.sessionId.value
    // ADR-0049：drafts 窄化为 DraftStore（不再持有 Map 引用），deleteDraft 经工厂 cleanup 移除分区
    if (sid) deps.drafts.deleteDraft(sid)
    deps.inputRef.value?.clear()
  }

  /** 发送失败恢复草稿到输入区 */
  function restoreInput(text: string): void {
    deps.draft.value = text
    deps.inputRef.value?.setText(text)
  }

  /**
   * 发送失败后恢复 text + 各类 chip（W8 修复；U2b 补 session/subagent 两类）。
   *
   * draft ref 同步（原 restoreInput 前半）+ restoreSegmentsIntoInput 统一实现
   * （text 重建 + chip 还原——与 ui ComposerInput.setSegments 共用的单一定义点）。
   * inputRef 为 null 时 draft 仍同步、DOM 写入跳过（原语义保持）。
   */
  function restoreSegments(segments: Segment[]): void {
    deps.draft.value = segments
      .filter((s): s is Extract<Segment, { type: 'text' }> => s.type === 'text')
      .map((s) => s.text)
      .join('')
    const input = deps.inputRef.value
    if (!input) return
    restoreSegmentsIntoInput(input, segments)
  }

  return { clearInput, restoreInput, restoreSegments }
}
