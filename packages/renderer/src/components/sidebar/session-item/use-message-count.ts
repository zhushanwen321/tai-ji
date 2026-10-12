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

/** 拉取目标的最小形状 = SessionItemSession 的 id + lastActiveAt 投影（函数签名内联对象类型——单实现无接口抽象） */

// @data-owner #62 —— #62 会话消息计数的 renderer 悬停卡缓存（单一写入口 = fetchSessionMessageCount
// 成功分支；权威源 = pi session JSONL 经 runtime 流式计数，本缓存只是 lastActiveAt 键控的
// 读穿 memo，失效键未变即复用；条目无删除通道——上界 = 悬停过的会话数，登记表主表 #62 行）
const messageCountCache = new Map<string, { count: number; lastActiveAt: number }>()

// taste:allow-no-data-owner W24-EX-C（已登记 data-source-registry §4 ⑧ 补登 2026-10-12）：
// getMessageCount 悬停拉取的 in-flight 去重簿记（Promise 句柄，非 GUI 数据本体——计数
// 数据本体在上方 messageCountCache），settle 即自清，对照 useGenStats inflightGenStatsFetch 先例
const inflightFetches = new Map<string, Promise<number | null>>()

/**
 * 取会话消息计数：缓存命中（lastActiveAt 未变）直接返回；否则经 in-flight 去重拉取。
 * 失败（RPC 错误/超时）返回 null 且不缓存——调用方占位不渲染，下次悬停自然重试。
 */
export function fetchSessionMessageCount(target: { id: string; lastActiveAt: number }): Promise<number | null> {
  const cached = messageCountCache.get(target.id)
  if (cached && cached.lastActiveAt === target.lastActiveAt) return Promise.resolve(cached.count)
  const inflight = inflightFetches.get(target.id)
  if (inflight) return inflight
  const fetchPromise = (async (): Promise<number | null> => {
    try {
      const reply = await command('session.getMessageCount', { sessionId: target.id }, RPC_BACKSTOP_TIMEOUT_MS)
      messageCountCache.set(target.id, { count: reply.count, lastActiveAt: target.lastActiveAt })
      return reply.count
    } catch {
      return null
    } finally {
      inflightFetches.delete(target.id)
    }
  })()
  inflightFetches.set(target.id, fetchPromise)
  return fetchPromise
}

/** 测试隔离钩子：清模块级缓存与 in-flight 表（防用例间残留）。生产代码禁止调用。 */
export function __resetMessageCountCacheForTest(): void {
  messageCountCache.clear()
  inflightFetches.clear()
}
