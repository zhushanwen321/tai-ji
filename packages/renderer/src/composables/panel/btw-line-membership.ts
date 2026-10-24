/**
 * btw-line-membership —— 抑制类分支的 btw 线成员判别供数（会话架构四层分离 W4b 收编，
 * 设计 §5-W4b 四步之①②）。
 *
 * 取代 `session.surfaces` 派生视图消息 + renderer 只读派生表（原 surface-by-session.ts
 * 的 surfaceBySessionId / isBtwSession——已随收编第三步按协议收缩删除）：成员判别改读
 * `session.list { surface:'btw' }` 的拉取缓存（同一注册表 owner 派生，验收项 12⑤ 的
 * 数据层等价性由 mock-domains 测试立证：surfaces 广播的 btw 成员 ≡ session.list 的
 * id 集合）。
 *
 * 契约（设计 §5-W4b ①②，逐条对应）：
 * - **覆盖度而非新鲜度**：surface 是存储位置的函数、终身不可变，故无失效逻辑；真实风险
 *   是覆盖度——拉取缓存只含拉取过的线，事件到达时未拉取过的线查找落空 = 抑制失效。
 *   缓解 = 读取点对「查找落空」显式补充拉取一次再判（拉到即抑制，不猜、不回退默认值）。
 * - **拉取失败分支**：显式未知 + warn 留痕，当次不抑制（失败方向 = 偶发全局通知 / 托盘
 *   派生，可接受；反向「猜成线」会永久丢通知，不可接受——ADR-0122 不猜）。
 * - **拉取时机**：抽屉打开（BtwPanel / useBtwTabData 的 session.list 拉取产物经
 *   noteBtwLinesPulled 喂入，同一来源不另起拉取）+ 完成 / 托盘 / fork / dialog 路由
 *   事件到达时按需拉（事件驱动，不轮询）。
 * - **两种喂入口径**（防覆盖度回退）：
 *   - `refreshBtwLineMembership` = 无过滤全量拉取，整表替换（快照语义，清掉已关线）；
 *   - `noteBtwLinesPulled` = 抽屉侧按 mainSessionId 过滤拉取的产物，**只增不减**地
 *     merge（过滤拉取的结果是全集子集，替换会把其他主会话的线挤出缓存——覆盖度回退）。
 *     已关线的 id 滞留与旧派生表同语义（删除不触发重播，随下一次全量拉取收敛）。
 * - **并发去重**：同一时刻只允许一次在途全量拉取（事件连续到达时防 RPC 风暴；在途
 *   请求的调用方共用同一 Promise，结果一致）。
 *
 * 登记：docs/constraints.json C-data-28 抑制类清单（usage=suppression）——本模块是四个
 * 抑制读取点唯一的成员判别入口，新增 surface 读取点不得另起拉取口径。
 */
import { shallowRef } from 'vue'
import { session } from '@/api'

/**
 * 拉取缓存：btw 线 session id 集合（merge 喂入只增不减；全量拉取整表替换）。
 *
 * @data-owner #77 —— btw 线成员判别拉取缓存（renderer 侧只读投影；权威源 = runtime 会话
 * 注册表 surface 事实，经 session.list {surface:'btw'} 拉取；喂入口 = noteBtwLinesPulled
 * merge + refreshBtwLineMembership 整表替换，无第二写方）
 */
const knownLines = shallowRef<ReadonlySet<string>>(new Set())

/** 在途全量拉取（并发去重；null = 当前无在途请求）。 */
let inFlight: Promise<ReadonlySet<string> | null> | null = null

/** 同步读缓存（渲染路径用）：true = 已确认是线；false = 未确认（可能从未拉取过）。 */
export function isKnownBtwLine(sessionId: string): boolean {
  return knownLines.value.has(sessionId)
}

/**
 * 抽屉侧 session.list 拉取产物喂入缓存（merge：抽屉拉取带 mainSessionId 过滤，结果是
 * 全集子集——只增不减，防把其他主会话的线挤出缓存）。
 */
export function noteBtwLinesPulled(sessionIds: readonly string[]): void {
  if (sessionIds.length === 0) return
  const next = new Set(knownLines.value)
  for (const id of sessionIds) next.add(id)
  knownLines.value = next
}

/**
 * 无过滤全量拉取一次 btw 线 id 集合并整表喂入缓存（快照语义：已关线的 id 出缓存）。
 * 失败 = 返回 null + warn 留痕（显式未知：保留上一张缓存不改半截，由调用方按
 * 「当次不抑制」处置）。
 */
export function refreshBtwLineMembership(): Promise<ReadonlySet<string> | null> {
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      const groups = await session.listSessions({ surface: 'btw' })
      const ids = groups.flatMap((g) => g.sessions).map((s) => s.id)
      knownLines.value = new Set(ids)
      return knownLines.value
    } catch (e) {
      console.warn('[btw-line-membership] session.list(surface:"btw") failed — 当次不抑制（显式未知）:', e)
      return null
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

/**
 * 读取点入口（成员判别）：缓存命中即判；落空显式补充拉取一次再判；拉取失败 = warn +
 * 当次不抑制（返回 false）。返回 true 仅两种来路：缓存命中或补充拉取后确认在线。
 */
export async function ensureBtwLineMembership(sessionId: string): Promise<boolean> {
  if (knownLines.value.has(sessionId)) return true
  const pulled = await refreshBtwLineMembership()
  return pulled?.has(sessionId) ?? false
}

/** 测试隔离：清空缓存与在途态（生产代码禁止调用）。 */
export function __resetBtwLineMembershipForTest(): void {
  knownLines.value = new Set()
  inFlight = null
}
