/**
 * Composer 提交动作（steer / followUp / submit / abort）。
 *
 * 职责单一：把 onSteer / onFollowUp / submit / onAbort 四个动作收口在此处，
 * 仅组合 useComposerRestore（clearInput / restoreInput）与 useChat（steer /
 * followUp / abort）提供的原语，不持任何状态。
 *
 * 提取到 composable 以满足 Composer.vue <script setup> 行数上限（300 行）。
 * 行为与原 Composer.vue 内联实现等价（仅搬运）；[D2] onSteer 例外——steer 返回 boolean
 * 后分支内消费失败恢复（restoreSegments），不再经 submit 的 catch 包装。
 *
 * 不含：onSend（fork/landing/compact 分支太多，留 Composer.vue）/ 输入编辑
 * （留 Composer.vue / 其他 composable）。
 *
 * [W3 迁移] 迁自 renderer composables/panel/useComposerSubmit.ts（零跨域 import 纯搬运）。
 * ComposerInputInstance 此处为本模块视角的最小契约（getSegments），与域级 types.ts 权威接口
 * ComposerInputInstance 互补——壳层 ComposerInput.vue 的 defineExpose 同时满足两者（结构类型）。
 */
import type { ComputedRef, Ref } from 'vue'
import type { Segment } from '@taiji/shared'

/**
 * ComposerInput 实例最小契约（getSegments 经 defineExpose 暴露）。
 * 用结构类型避免 import .vue 文件（循环依赖 + 类型推断复杂），
 * 同 useComposerRestore / useComposerContextChips 范式。
 */
interface ComposerInputInstance {
  getSegments: () => Segment[]
}

interface ComposerSubmitDeps {
  /** 是否有输入（onSteer / onFollowUp 前置守卫） */
  hasInput: ComputedRef<boolean>
  /** session 是否活跃（onSteer 仅活跃态触发；onAbort 语义也依赖活跃） */
  isActive: ComputedRef<boolean>
  /** draft ref（纯文本用于空判断 + 失败恢复） */
  draft: Ref<string>
  /** inputRef（ComposerInput 实例 ref，getSegments 快照用） */
  inputRef: Ref<ComposerInputInstance | null>
  /** sessionId ref（steer/followUp/abort 调用参数） */
  sessionIdRef: ComputedRef<string | null>
  /** 清空输入（useComposerRestore 提供） */
  clearInput: () => void
  /** 恢复草稿（useComposerRestore 提供，submit 失败回滚用） */
  restoreInput: (text: string) => void
  /** 恢复草稿 text + 各类 chip（useComposerRestore 提供）。[D2] onSteer 失败时恢复完整
   *  segments（与 send.ts routeSteer 同款——S4 验收要求文本 + chips 完整恢复）。 */
  restoreSegments: (segments: Segment[]) => void
  /** 追加 steer（useChat 提供）。[D2] 返回 false = RPC 失败（内部已 toast），调用方恢复草稿。 */
  steer: (sessionId: string, segments: Segment[]) => Promise<boolean>
  /** 追加 follow-up（useChat 提供） */
  followUp: (sessionId: string, segments: Segment[]) => Promise<void>
  /** 停止当前回合（useChat 提供） */
  abort: (sessionId: string) => Promise<void>
}

/**
 * @param deps hasInput / isActive / draft / inputRef / sessionIdRef /
 *   clearInput / restoreInput / restoreSegments / steer / followUp / abort（Composer.vue 内定义后注入）
 */
export function useComposerSubmit(deps: ComposerSubmitDeps) {
  /**
   * 公共提交：空文本拦截 → 清空输入 → sender → 失败恢复草稿。
   *
   * 不在此处 toast（与 onSend 不同）：submit 被 steer/followUp 复用，
   * 调用方语义各异，错误透传由各自上游（store/UI）决定如何呈现。
   */
  async function submit(text: string, sender: () => Promise<void>): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed) return
    deps.clearInput()
    try {
      await sender()
    } catch (e) {
      deps.restoreInput(text)
      throw e
    }
  }

  /** 追加 steer：活跃态有输入时 ⏎ 触发。segments 先快照（clearInput 会清空 DOM）。
   *  [D2] 不经 submit 的 sender 包装消费：steer 内部 catch 不抛（toast + return false）后，
   *  submit 的 catch → restoreInput → rethrow 对 steer 成为 dead path——分支内直接消费
   *  boolean，失败 restoreSegments 恢复完整草稿（text + chips，与 routeSteer 同款）。 */
  async function onSteer(): Promise<void> {
    if (!deps.hasInput.value || !deps.isActive.value) return
    // clearInput 会清空 DOM，必须在清空前提取 segments，否则丢段（同 onSend 快照范式）
    const segments = deps.inputRef.value?.getSegments() ?? []
    const text = deps.draft.value
    if (!text.trim()) return
    deps.clearInput()
    if (!(await deps.steer(deps.sessionIdRef.value!, segments))) {
      deps.restoreSegments(segments)
    }
  }

  /** 追加 follow-up：Alt+⏎ 触发；非流式退化为普通发送 */
  async function onFollowUp(): Promise<void> {
    if (!deps.hasInput.value) return
    const segments = deps.inputRef.value?.getSegments() ?? []
    await submit(deps.draft.value, () => deps.followUp(deps.sessionIdRef.value!, segments))
  }

  /** 停止（S6）：调 abort（G-025 流转 DEFERRED，方法存在） */
  async function onAbort(): Promise<void> {
    await deps.abort(deps.sessionIdRef.value!)
  }

  return { onSteer, onFollowUp, submit, onAbort }
}
