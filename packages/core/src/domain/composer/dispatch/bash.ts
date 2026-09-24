/**
 * Composer bash 命令模式（composer-bash-execute）。
 *
 * 从 draft 派生 isBashMode（`!` 前缀触发），并在 onSend 提交时提供 trySendBash
 * 分流入口：命中 `!`/`!!` 前缀时执行 bash（不经 LLM turn），返回 true 表示已处理
 * （调用方不再走普通 send / compact 分支）。
 *
 * bash 不走 segment 提取（原始 shell 文本透传 pi bash RPC）。
 *
 * 错误策略：sendBash（壳层注入）内部已 try/catch + toast 且不重抛（与 send/abort/compact
 * 对称）。[R2-A5 同族/b08] 失败信号契约：sendBash 返回 false = RPC 失败——本 composable
 * 消费该信号 console.warn 留痕（失败时输入已清、当前无恢复原语，见下）。
 * 已知限制（renderer 侧剩余缺口）：sendBash 失败时 !command 文本丢失（草稿已在 clearInput
 * 清空）。恢复需壳层（composer-shell 的 useComposerBash 注入点）传入 restoreInput 后在本
 * composable 的失败分支接线——bash 文本不经 segments（原始 shell 文本透传），restoreSegments
 * 不适用，须纯文本 restoreInput。
 *
 * [W3 迁移] 迁自 renderer composables/panel/useComposerBash.ts。改动：
 * - 去掉 renderer 跨域依赖 `import { useChat } from '@/composables/features/useChat'`
 *   + 内部 `const { sendBash } = useChat()`。改为经 ComposerBashOptions.sendBash 回调注入
 *   （壳层从 useChat 派生后传入），core 零 composable 依赖。
 * - BashCommandExtract 类型：删 renderer 本地定义，从 core domain/composer types（`../types`）import。
 * 逻辑 byte-level 保持。
 */
import { computed, type ComputedRef, type Ref } from 'vue'
import type { BashCommandExtract } from '../types'

/** `!` 与 `!!` 前缀长度（单/双感叹号） */
const BANG_SINGLE = 1
const BANG_DOUBLE = 2

export interface ComposerBashOptions {
  /** draft 文本（isBashMode 派生源） */
  draft: Ref<string>
  /** 清空输入（乐观 UI：提交前先清） */
  clearInput: () => void
  /** 发送中状态（trySendBash 期间置 true） */
  isSending: Ref<boolean>
  /** session id（landing 态为 null，调用方需保证 trySendBash 在非 landing 分支调用） */
  sessionId: () => string | null
  /** 执行 bash 命令（useChat.sendBash 注入）。内部已 try/catch + toast 且不重抛。
   *  [R2-A5 同族] 返回 false = RPC 失败（宽兼容槽：Promise<void> 提供方同样可注入）。 */
  sendBash: (sessionId: string, command: string, excludeFromContext: boolean) => Promise<boolean | void>
}

export interface UseComposerBash {
  /** bash 模式（draft 以 `!` 开头）—— 供 useComposerModeVisual 视觉派生 */
  isBashMode: ComputedRef<boolean>
  /**
   * [W5] 从文本提取 bashCommand（discriminated union）。landing 态首发用。
   * 调用方按 `.type` 分支处理：`'empty'` → 不提交；`'command'` → 传给 submitFirstMessage。
   */
  extractBashCommand: (text: string) => BashCommandExtract
  /**
   * 尝试 bash 分流。命中 `!`/`!!` 前缀时执行 bash 并返回 true（调用方 return）；
   * 否则返回 false（调用方继续走 compact / send 分支）。
   *
   * 空命令（`!` 或 `!!` 后无内容）不提交，返回 true 保持 bash 模式（保留前缀供继续输入）。
   */
  trySendBash: (rawText: string) => Promise<boolean>
}

export function useComposerBash(opts: ComposerBashOptions): UseComposerBash {
  const isBashMode = computed(() => opts.draft.value.trimStart().startsWith('!'))

  /**
   * [W5] 从文本提取 bashCommand（discriminated union）。
   * 替代原 undefined|null|object 三态，调用方按 .type 分支处理。
   */
  function extractBashCommand(text: string): BashCommandExtract {
    const trimmed = text.trim()
    if (!trimmed.startsWith('!')) return { type: 'not-bash' }
    const isExcluded = trimmed.startsWith('!!')
    const cmd = trimmed.slice(isExcluded ? BANG_DOUBLE : BANG_SINGLE).trim()
    if (!cmd) return { type: 'empty' }
    return { type: 'command', command: cmd, excludeFromContext: isExcluded }
  }

  async function trySendBash(rawText: string): Promise<boolean> {
    // S12：复用 extractBashCommand 统一 !/!! 前缀解析，消除重复的 slice/trim/判空逻辑。
    const extracted = extractBashCommand(rawText)
    if (extracted.type === 'not-bash') return false
    // 空命令：不提交但视为已处理（保持 bash 模式，保留前缀供继续输入）
    if (extracted.type === 'empty') return true

    const sid = opts.sessionId()
    if (!sid) return false

    opts.clearInput()
    opts.isSending.value = true
    let delivered: boolean | void
    try {
      delivered = await opts.sendBash(sid, extracted.command, extracted.excludeFromContext)
    } finally {
      opts.isSending.value = false
    }
    // [R2-A5 同族] 显式 false = RPC 失败（错误已由 useChat.sendBash toast 消化）；严格比较
    // 只认显式信号——宽兼容槽下 void 提供方 resolve undefined（含成功路径）不误报。输入恢复
    // 为 renderer 侧剩余缺口：restoreInput 未注入（见模块头注释），先 console.warn 留痕——
    // 静默丢输入 ≠ 无声失败。
    if (delivered === false) {
      console.warn(`[useComposerBash] bash 执行失败，命令文本未恢复（restoreInput 待壳层注入）: ${extracted.command}`)
    }
    return true
  }

  return { isBashMode, extractBashCommand, trySendBash }
}
