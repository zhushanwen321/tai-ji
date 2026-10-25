// turn-timer —— 回合计时与步数的客户端派生纯函数（remote-use-mobile-v2 §6.21）。
//
// 口径（§6.21 采用段，显式声明）：
// - 计时起点 = 本端观察到回合开始的本地时刻（chat store isGenerating false→true 边沿；
//   runtime 无 turnStartedAt 信号，与 tokenCreatedAt 同判例不为展示新增协议）。中途接入
//   （点入生成中的会话）或刷新后回到聊天页时起点 = 接入时刻——显示值 < 回合真实耗时且
//   偏差无上界，UI 以「已观察」措辞标注（不把显示值伪装成回合真实耗时）。
// - 步数 = 本回合工具调用完成计数：从回合起点消息索引起（上升沿观察时的分区尾部锚点，
//   user 消息总在回合起点前入分区——锚点至多回看一条无工具的 user/占位消息），统计各
//   消息 toolCalls 中 status ≠ 'running' 的条数（overlay 语义：running → completed 原地
//   翻转，见 core store applyToolCallOverlay）。
// - 仅对已订阅会话显示：isGenerating 只在订阅后可观察，「仅生成中显示」构造性蕴含
//   「未订阅不显示」（§6.21 口径限制的落点）。
import type { Message } from '@taiji/shared'

/** 换算常量（计时格式的单位边界）：ms→s 除数、s→m 除数、mm:ss 两位补零 */
const MS_PER_SECOND = 1000
const SECONDS_PER_MINUTE = 60
const PAD_WIDTH = 2

/** MM:SS 计时文案（分钟不封顶——超 60min 显示 75:30 形态，不进小时位换挡）。 */
export function formatObservedDuration(startAtMs: number, nowMs: number): string {
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - startAtMs) / MS_PER_SECOND))
  const minutes = Math.floor(elapsedSeconds / SECONDS_PER_MINUTE)
  const seconds = elapsedSeconds % SECONDS_PER_MINUTE
  return `${String(minutes).padStart(PAD_WIDTH, '0')}:${String(seconds).padStart(PAD_WIDTH, '0')}`
}

/** 本回合工具调用完成计数：[fromIndex, 分区尾) 内各消息 toolCalls 中非 running 条数。 */
export function countCompletedToolCalls(messages: readonly Message[], fromIndex: number): number {
  let count = 0
  for (let i = Math.max(0, fromIndex); i < messages.length; i++) {
    const calls = messages[i]?.toolCalls
    if (!calls) continue
    for (const call of calls) {
      if (call.status !== 'running') count++
    }
  }
  return count
}

/**
 * 回合起点消息索引（上升沿观察时调用）：分区尾部锚点 = max(0, length - 1)——观察时最后
 * 一条至多是刚 append 的 assistant 占位 / 本回合触发消息，向前多含一条的代价是上一回合
 * 尾消息的完成工具计数被并入（仅当上升沿与上回合尾消息相邻且上回合终态帧未先到——
 * isGenerating 上升沿蕴含上一回合已终结，其工具计数属历史回合，锚点回看一条的窗口内
 * 不含它的可靠前提 = user 消息在两回合之间入分区；steer 注入无上升沿，不受影响）。
 */
export function turnStartIndexAt(messages: readonly Message[]): number {
  return Math.max(0, messages.length - 1)
}
