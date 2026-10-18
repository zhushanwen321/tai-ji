/**
 * 会话消息计数拉取（悬停详情卡消息计数）。
 *
 * 拉取式（拉为主、推补充第一原则）：悬停详情卡打开时按需调 session.getMessageCount RPC，
 * 不预取全部会话、不订阅推送——悬停时拉取即最新。
 *
 * 缓存口径（模块级 Map，key = sessionId）：value 记录 count + 取数时的 session.lastActiveAt；
 * 命中且 lastActiveAt 未变直接用缓存，变了重新拉取——lastActiveAt 是 pi append 后必然变化的
 * 失效键（SessionSummary 随扫描刷新），最简正确口径。读失败不缓存（下次悬停重试），
 * renderer 收 null 显示占位（计数段不渲染，不闪 0）。
 */
import { command, RPC_BACKSTOP_TIMEOUT_MS } from '@taiji/core/transport/api'
import { createInflightDedup } from '@taiji/core/foundation/create-inflight-dedup'

/** 拉取目标的最小形状 = SessionItemSession 的 id + lastActiveAt 派生视图（函数签名内联对象类型——单实现无接口抽象） */

// @data-owner #62 —— #62 会话消息计数的 renderer 悬停卡缓存（单一写入口 = fetchSessionMessageCount
// 成功分支；权威源 = pi session JSONL 经 runtime 流式计数，本缓存只是 lastActiveAt 键控的
// 读穿 memo，失效键未变即复用；条目无删除通道——上界 = 悬停过的会话数，登记表主表 #62 行）。
// C-data-18 三分裁决 = 保留手写：非 in-flight 去重族（无并发去重语义），非 KV 单键族
// （纯内存读穿 memo，无 KV 持久化生命周期骨架，不适用 createKVSlot），属三分处置
// 「对抗外部异步真值（保留）」类——lastActiveAt 失效键键控的按需重新拉取即其全部机制。
const messageCountCache = new Map<string, { count: number; lastActiveAt: number }>()

// taste:allow-no-data-owner W24-EX-C（已登记 data-source-registry §4 ⑧ 补登 2026-10-12）：
// getMessageCount 悬停拉取的 in-flight 去重簿记（Promise 句柄，非 GUI 数据本体——计数
// 数据本体在上方 messageCountCache）。createInflightDedup 收编（C-data-18：同 key 并发
// 异步去重禁再手写 Map+Promise 同构实现），settle 即清与引用比对防误删由 factory 内建。
const inflightFetches = createInflightDedup<number | null>()

/**
 * 取会话消息计数：缓存命中（lastActiveAt 未变）直接返回；否则经 in-flight 去重重新拉取。
 * 失败（RPC 错误/超时）返回 null 且不缓存——调用方占位不渲染，下次悬停自然重试。
 */
export function fetchSessionMessageCount(target: { id: string; lastActiveAt: number }): Promise<number | null> {
  const cached = messageCountCache.get(target.id)
  if (cached && cached.lastActiveAt === target.lastActiveAt) return Promise.resolve(cached.count)
  const { promise } = inflightFetches.run(target.id, async () => {
    try {
      const reply = await command('session.getMessageCount', { sessionId: target.id }, RPC_BACKSTOP_TIMEOUT_MS)
      messageCountCache.set(target.id, { count: reply.count, lastActiveAt: target.lastActiveAt })
      return reply.count
    } catch {
      return null
    }
  })
  return promise
}

/** 测试隔离钩子：清模块级缓存与 in-flight 表（防用例间残留）。生产代码禁止调用。 */
export function __resetMessageCountCacheForTest(): void {
  messageCountCache.clear()
  inflightFetches.clear()
}
