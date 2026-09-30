/**
 * Composer 提交动作（followUp / abort）。
 *
 * 职责单一：把 onFollowUp / onAbort 两个动作收口在此处，仅组合 useComposerRestore
 * （clearInput）与 useChat（followUp / abort）提供的原语，不持任何状态。
 *
 * 提取到 composable 以满足 Composer.vue <script setup> 行数上限（300 行）。
 * onFollowUp 在分支内消费 useChat 失败信号（false → restoreSegments 恢复草稿）。
 *
 * [退役] onSteer 与 submit() 包装已随 ADR-0046 message.steer 协议腿退役同批删除
 * （过度设计审计候选 8）：Enter 统一走 onSend→routeSteer（steer 车道判定在 runtime 内核），
 * onSteer 生产调用方为 0；submit() 包装的 catch 对不抛错的 useChat 契约是 dead path 且
 * 生产调用方为 0。
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
  /** 是否有输入（onFollowUp 前置守卫） */
  hasInput: ComputedRef<boolean>
  /** inputRef（ComposerInput 实例 ref，getSegments 快照用） */
  inputRef: Ref<ComposerInputInstance | null>
  /** sessionId ref（followUp/abort 调用参数） */
  sessionIdRef: ComputedRef<string | null>
  /** 清空输入（useComposerRestore 提供） */
  clearInput: () => void
  /** 恢复草稿 text + 各类 chip（useComposerRestore 提供）。onFollowUp 失败时恢复完整
   *  segments——S4 验收要求文本 + chips 完整恢复。 */
  restoreSegments: (segments: Segment[]) => void
  /** 追加 follow-up（useChat 提供）。[R2-A5] 返回 false = RPC 失败（内部已
   *  toast），调用方恢复草稿。 */
  followUp: (sessionId: string, segments: Segment[]) => Promise<boolean>
  /** 停止当前回合（useChat 提供） */
  abort: (sessionId: string) => Promise<void>
}

/**
 * @param deps hasInput / inputRef / sessionIdRef /
 *   clearInput / restoreSegments / followUp / abort（Composer.vue 内定义后注入）
 */
export function useComposerSubmit(deps: ComposerSubmitDeps) {
  /**
   * 追加 follow-up：Alt+⏎ 触发；非流式退化为普通发送。
   * [R2-A5 失败恢复] followUp 契约内不 throw（toast + 返回失败信号）——分支内消费
   * boolean，失败 restoreSegments 恢复完整草稿（text + chips）。不补 toast（useChat
   * 内部已 toast，防双提示）。
   */
  async function onFollowUp(): Promise<void> {
    if (!deps.hasInput.value) return
    // clearInput 会清空 DOM，必须在清空前提取 segments（同 onSend 快照范式）
    const segments = deps.inputRef.value?.getSegments() ?? []
    deps.clearInput()
    // 严格比较 false：只认显式失败信号
    const delivered = await deps.followUp(deps.sessionIdRef.value!, segments)
    if (delivered === false) deps.restoreSegments(segments)
  }

  /** 停止（S6）：调 abort（G-025 流转 DEFERRED，方法存在） */
  async function onAbort(): Promise<void> {
    await deps.abort(deps.sessionIdRef.value!)
  }

  return { onFollowUp, onAbort }
}
