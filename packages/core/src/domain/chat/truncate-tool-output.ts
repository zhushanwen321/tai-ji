/**
 * W2 H3：tool result 共享截断工具。
 *
 * [归位] 迁自 renderer src/utils/truncate-tool-output.ts（P3 chat 域绞杀：chat-message-effects
 * 迁 core/src/domain/chat/effects/registry.ts 时，tool_call_end handler 依赖 truncateToolCall；
 * chat.ts 仍依赖 truncateToolOutputBatch，改从 @taiji/core 取）。内容零改动，仅归位。
 *
 * 对应 FR-2 + D7/D9/D10/D12 + AC-3/4/10/11/13。
 *
 * 核心策略：
 * - toolName ∈ TRUNCATE_TOOLS（read/bash/cat/grep/glob/list）的 output/outputRaw
 *   按头部 TOOL_OUTPUT_MAX_BYTES(4KB) 截断 + 省略标记
 * - MCP 命名空间前缀（mcp__server__read）按末段匹配（D12）
 * - UTF-8 codepoint 边界对齐，不切断多字节字符（D10/AC-11）
 * - write/edit 不截断（AC-4）
 * - details.__gui__ 结构化数据不截断
 * - ≤4KB 不截断、不加标记
 *
 * 共享入口（D9/SR1）：实时路径（tool_call_end handler）和历史回流路径
 * （hydrate/setMessages）都调用此函数，保证两条路径截断策略一致。
 */
import type { Message } from '@taiji/shared'

/**
 * 需要截断 output 的工具名（D7/AC-4）。
 * 这些工具的 output 可能很大（文件内容、命令输出、搜索结果）。
 *
 * MCP 工具命名约定：mcp server 暴露的工具名形如 `mcp__<server>__<tool>`
 * （双下划线分段，末段为工具短名）。末段匹配让 TRUNCATE_TOOLS 对 MCP
 * 命名空间工具同样生效（如 mcp__fs__read 命中 read）。
 */
export const TRUNCATE_TOOLS = new Set([
  'read', 'bash', 'cat', 'grep', 'glob', 'list',
])

/** 截断阈值：4KB（UTF-8 字节，D10） */
export const TOOL_OUTPUT_MAX_BYTES = 4096

/** 截断省略标记（D7） */
const TRUNCATION_MARKER = '\n\n[...output truncated...]'

/**
 * TextEncoder/TextDecoder 模块级单例（S9）。
 * 这些是无状态工具对象，构造零成本但重复 new 仍是不必要分配。提为模块级单例复用。
 * Decoder fatal=false：截断体在 codepoint 边界对齐（truncateToBytes 内保证），
 * 即便边界对齐有偏差也不抛错（容错 decode 截断字节）。
 */
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8', { fatal: false })

/** 省略标记的 UTF-8 字节长度（常量串，模块级预算一次——避免每次 truncateToolCall 重复编码） */
const TRUNCATION_MARKER_BYTES = textEncoder.encode(TRUNCATION_MARKER).length

/**
 * 判断 toolName 是否需要截断（D12 MCP 前缀兼容）。
 * mcp__server__read 按末段匹配 read。
 */
export function shouldTruncate(toolName: string): boolean {
  if (TRUNCATE_TOOLS.has(toolName)) return true
  // MCP 命名空间前缀：按 __ split 取最后一段匹配。
  // split 结果恒非空（即使空串也返回 ['']），用 ?? '' 兜底替代非空断言，
  // 让类型表达更显式——空串不会命中 TRUNCATE_TOOLS，行为等价且无 ! 。
  if (toolName.includes('__')) {
    const lastSegment = toolName.split('__').pop() ?? ''
    return TRUNCATE_TOOLS.has(lastSegment)
  }
  return false
}

/**
 * UTF-8 续字节位掩码（10xxxxxx = 0x80-0xBF）。
 * 用于 codepoint 边界对齐检测：续字节的高 2 位是 10。
 */
const UTF8_CONTINUATION_MASK = 0xC0
const UTF8_CONTINUATION_PREFIX = 0x80

/**
 * 已持有 UTF-8 编码结果时的截断内联变体：边界对齐逻辑与 truncateToBytes 完全一致，
 * 编码 bytes 由调用方传入复用——truncateToolCall 判定超限与执行截断共用一次编码，
 * 避免同一字符串二次 encode（MB 级 output 单次 encode ≈ 1-2ms）。bytes 必须是 str
 * 的 UTF-8 编码（TextEncoder 确定性：同输入编码字节恒全等，复用安全）。
 */
function truncateEncodedBytes(str: string, bytes: Uint8Array, maxBytes: number): string {
  if (bytes.length <= maxBytes) return str

  // 从 maxBytes 往前找 codepoint 边界
  // UTF-8 多字节字符：首字节高位是 11xxxxxx，续字节是 10xxxxxx
  // 找到第一个非续字节位置即为 codepoint 起点
  let cutPos = maxBytes
  // 往回找直到不是续字节（10xxxxxx = 0x80-0xBF）
  while (cutPos > 0 && (bytes[cutPos]! & UTF8_CONTINUATION_MASK) === UTF8_CONTINUATION_PREFIX) {
    cutPos--
  }
  return textDecoder.decode(bytes.subarray(0, cutPos))
}

/**
 * 按 UTF-8 字节截断字符串，在 codepoint 边界对齐（AC-11/D10）。
 * 不切断多字节字符（如 CJK 3 字节字符不会被切成半个）。
 *
 * 用 TextEncoder 代替 Node.js Buffer（浏览器端无 Buffer 全局）。
 */
export function truncateToBytes(str: string, maxBytes: number): string {
  return truncateEncodedBytes(str, textEncoder.encode(str), maxBytes)
}

/**
 * 截断单个 ToolCall 的 output/outputRaw（D7）。
 * 只截断 shouldTruncate(toolName) 的工具，其余原样返回。
 *
 * 截断后**含标记**总字节数 ≤ TOOL_OUTPUT_MAX_BYTES。
 *
 * 导出供 tool_call_end handler 在更新单个 toolCall 时直接调用（实时路径）。
 */
export function truncateToolCall<T extends import('@taiji/shared').ToolCall>(tc: T): T {
  if (!shouldTruncate(tc.toolName)) return tc

  let truncated = false
  const next: Partial<T> = {}
  // 截断体预算 = MAX - marker，保证含标记后总长 ≤ MAX
  const bodyBudget = TOOL_OUTPUT_MAX_BYTES - TRUNCATION_MARKER_BYTES

  if (tc.output !== undefined) {
    // 判定与截断共用同一次编码结果（MB 级 output 下省掉截断路径的二次 encode）
    const encoded = textEncoder.encode(tc.output)
    if (encoded.length > TOOL_OUTPUT_MAX_BYTES) {
      next.output = truncateEncodedBytes(tc.output, encoded, bodyBudget) + TRUNCATION_MARKER
      truncated = true
    }
  }
  if (tc.outputRaw !== undefined) {
    const encoded = textEncoder.encode(tc.outputRaw)
    if (encoded.length > TOOL_OUTPUT_MAX_BYTES) {
      next.outputRaw = truncateEncodedBytes(tc.outputRaw, encoded, bodyBudget) + TRUNCATION_MARKER
      truncated = true
    }
  }

  return truncated ? { ...tc, ...next } : tc
}

/**
 * 截断 Message 中的 tool result（共享入口，D9）。
 *
 * 遍历 message.toolCalls，对每个需要截断的 toolCall 应用 4KB 头部截断。
 * 无 toolCalls 的消息原样返回。details.__gui__ 等结构化字段不截断。
 *
 * 不可变写法：返回新对象（与 chat store commitMessages 的不可变约定一致）。
 *
 * [不可变约束 R7] 本函数**不 mutate 入参 msg 及其 toolCalls**——始终返回新对象
 * （`{...msg, toolCalls: newToolCalls}`），newToolCalls 是 `.map(truncateToolCall)`
 * 产出的新数组，truncateToolCall 返回 `{...tc, ...next}` 新对象。调用方
 * （hydrate/setMessages/prependHistory）传入的 history 的 toolCalls 永不被修改。
 * 不做深 clone toolCalls（大 toolCall 含 MB 级 output，深 clone 开销不合理）。
 *
 * @param msg 原始 Message
 * @returns 截断后的 Message（如无截断则原样返回同一引用）
 */
export function truncateToolOutput(msg: Message): Message {
  if (!msg.toolCalls || msg.toolCalls.length === 0) return msg

  let anyTruncated = false
  const newToolCalls = msg.toolCalls.map((tc) => {
    const truncated = truncateToolCall(tc)
    if (truncated !== tc) anyTruncated = true
    return truncated
  })

  return anyTruncated ? { ...msg, toolCalls: newToolCalls } : msg
}

/**
 * 批量截断 Message[]（hydrate/setMessages 回流路径用，AC-10）。
 */
export function truncateToolOutputBatch(messages: Message[]): Message[] {
  let anyTruncated = false
  const result = messages.map((m) => {
    const truncated = truncateToolOutput(m)
    if (truncated !== m) anyTruncated = true
    return truncated
  })
  return anyTruncated ? result : messages
}

/**
 * 批量截断 + 已投影产物缓存（subagent 基线投影专用，applySubagentEntries §6.1）。
 *
 * cache 命中的消息直接复用上次投影产物——引用恒等 ⇒ 内容恒等 ⇒ 截断结果恒等
 * （ADR-0039 消息不可变替换 + 本模块纯函数，构造性成立），跳过重判定的重复 encode；
 * 未命中消息走 truncateToolOutput 并记账产物。消除 subagent 活跃期间每帧投影对分区
 * 全部历史消息 toolCall 原文（reducer 累积态另有 64KB 条目级截断
 * ENTRY_TOOL_OUTPUT_MAX_BYTES，见 apply-entry-utils.ts；本函数 4KB 是渲染投影层，
 * 两层级正交）的重复 encode。
 *
 * 输出形态对齐调用方既有链路 `truncateToolOutputBatch(messages.map((m) => ({ ...m })))`：
 * 恒返回新数组；未命中消息 = 浅拷贝经 truncateToolOutput 判定（截断换新 toolCalls 数组，
 * 无截断返回浅拷贝）；命中消息 = 上次产物原引用（逐值恒等于重跑判定——重跑幂等收敛到
 * 首次截断结果，复用产物只是免掉重跑 encode）。cache 只记账「输入引用 → 产物」（WeakMap
 * 弱引用，消息对象随分区销毁 GC 后条目自动回收，无需清理挂点；重进分区 reducer 重建的
 * 新对象不命中，照常判定）。**注意截断产物不回写输入源**（reducer state.messages 保持
 * 全量原文权威镜像），产物只用于投影输出复用。
 *
 * **前置条件**：messages 来自同一权威累积源且不可变替换（reducer state.messages——
 * 引用复用即内容复用）。不满足时（入参可能被 mutate / 跨源复用同引用异内容）用
 * truncateToolOutputBatch。
 */
export function truncateToolOutputBatchCached(messages: Message[], cache: WeakMap<Message, Message>): Message[] {
  return messages.map((m) => {
    const cached = cache.get(m)
    if (cached !== undefined) return cached
    const truncated = truncateToolOutput({ ...m })
    cache.set(m, truncated)
    return truncated
  })
}
