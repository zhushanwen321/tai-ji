/**
 * delta-coalescer —— 高频 delta 消息的 microtask 批量合帧（perf 07 文档 D-2，W12）。
 *
 * 问题（07 §2.3.3 R3）：pi 每推一个 text_delta/thinking_delta，useChat 回调就直推一次
 * applyMessageEvent → commitMessages → 失效扇出，提交次数 = token 数。本模块在 useChat
 * 订阅回调与 store 之间加一层合帧，把「连续同类型 delta」收敛为「每 microtask 一次提交」。
 *
 * 语义（07 §3.3.1 (7) + 裁决 R-18）：
 * - 同 sid 同 type 的 delta 在同一 microtask 窗口内保序合并（key = `${sid}:${type}`），
 *   text 与 thinking 分 key 缓存互不合并；
 * - 任何非 delta 的 message.* 到达时，先同步 flush 同 sid 缓冲再 dispatch 原消息——
 *   保序（终态前的 delta 全部落地）+ 终态即时（不依赖 microtask）；
 * - 异 sid 缓冲互不阻塞（flush 按 sid 过滤；一个 sid 的终态只 flush 它自己的缓冲）；
 * - flush 逐 buffer try/catch 隔离：一个 sid 失败不阻塞其余缓冲，console.warn 不 throw
 *   （对齐 useChat best-effort 策略）。
 *
 * 跨类型交错顺序边界：text/thinking 交错到达时，flush 对两类缓冲的 dispatch 相对顺序
 * 不保证（同类型内保序）——registry 对两类型独立累积（text 进 content、thinking 进
 * trace 不同字段），dispatch 顺序颠倒不影响最终内容。
 *
 * 合成对象形状（R-18）：首条消息浅拷贝 + payload.delta 覆盖为拼接结果——首条 id 与
 * payload 伴随字段（contentIndex 等）自然透传；seq 不合成（透传首条原值即为「不合成新序」，
 * 合成消息是 transient 消费，不回注 MessageBus，不参与 seq 去重）。registry 的
 * text_delta handler 依赖 contentIndex 做 insertContentBlockByIndex 有序插入，首条即
 * 定位依据（后续 delta 同 contentIndex 或 undefined 均可）。
 *
 * 合帧只在 useChat 层：直接调 store.applyMessageEvent 的既有测试/调用方不受影响
 * （07 §5.2 U4：registry.ts delta handler 不改）。
 */
import type { ServerMessage } from '@taiji/shared'
import { readString } from './readers'

/** 参与合帧的 delta 消息类型（仅这两类是逐 token 高频推送，07 §3.3.1 (7)） */
const COALESCED_TYPES = new Set<string>(['message.text_delta', 'message.thinking_delta'])

/** flush 时把消息应用到目标 store 分区的入口（useChat 注入 `(m) => chat.applyMessageEvent(sid, m)`） */
type Dispatch = (msg: ServerMessage) => void

interface DeltaBuffer {
  sid: string
  /** 首条 delta 消息（合成对象的原型：id / payload 伴随字段透传源） */
  firstMsg: ServerMessage
  /** 同 microtask 窗口内按到达序累积的 delta 片段 */
  texts: string[]
  /** 首条消息的 dispatch 闭包（含 sid 路由；同 session 生命周期内 store 实例不变） */
  dispatch: Dispatch
}

export interface MessageCoalescer {
  /** message.* 消息入口：delta 类缓冲，其余先 flush(sid) 再同步 dispatch */
  enqueue(sid: string, msg: ServerMessage, dispatch: Dispatch): void
  /** 立即 flush 指定 sid 的缓冲（disposeSession 收口兜底）；缺省 flush 全部 */
  flush(sid?: string): void
  /** 丢弃全部缓冲并复位调度位（测试隔离专用） */
  clear(): void
}

export function createMessageCoalescer(): MessageCoalescer {
  const pending = new Map<string, DeltaBuffer>()
  let scheduled = false

  function flush(sid?: string): void {
    for (const [key, buf] of pending) {
      if (sid !== undefined && buf.sid !== sid) continue
      pending.delete(key)
      try {
        const synthetic: ServerMessage = {
          ...buf.firstMsg,
          payload: { ...buf.firstMsg.payload, delta: buf.texts.join('') },
        }
        buf.dispatch(synthetic)
      // eslint-disable-next-line taste/no-silent-catch -- 逐 buffer 错误隔离（07 §3.3.3 (1)）：不 catch 则一个 buffer 抛错中断循环、其余 sid 缓冲滞留；仅 warn 不 throw（对齐 useChat best-effort）。
      } catch (e) {
        console.warn(`[delta-coalescer] flush failed for session ${buf.sid} (${buf.firstMsg.type}) — this batch of deltas is dropped, subsequent deltas accumulate normally:`, e)
      }
    }
  }

  return {
    enqueue(sid, msg, dispatch) {
      if (!COALESCED_TYPES.has(msg.type)) {
        // 非 delta（message_start/complete/tool_call_*/thinking_start/end 等）：
        // 先 flush 同 sid 缓冲保序，再同步 dispatch——终态即时可见，不等 microtask。
        flush(sid)
        dispatch(msg)
        return
      }
      const key = `${sid}:${msg.type}`
      // 宽 ServerMessage.payload 联合收窄（对齐 useChat 回调的 `msg.payload as {...}` 惯例）；
      // 字段安全由 readString 的 typeof guard 兜底（非 string 回退 ''，registry 同语义）。
      const payload = msg.payload as Record<string, unknown>
      const buf = pending.get(key)
      if (buf) {
        buf.texts.push(readString(payload, 'delta') ?? '')
      } else {
        pending.set(key, {
          sid,
          firstMsg: msg,
          texts: [readString(payload, 'delta') ?? ''],
          dispatch,
        })
      }
      if (!scheduled) {
        scheduled = true
        queueMicrotask(() => {
          scheduled = false
          flush()
        })
      }
    },
    flush,
    clear() {
      // scheduled 复位后，已排队的 microtask 会跑一次空 flush（pending 已清，no-op），无害
      pending.clear()
      scheduled = false
    },
  }
}
