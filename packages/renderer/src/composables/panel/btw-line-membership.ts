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
 *   缓解 = 读取点对「查找落空」显式补充拉取一次再判（拉到即抑制，不猜、不回退默认值）；
 *   已被完整拉取确认非线的 id 走负向记忆，不再重复补充拉取（见「负向记忆」条）。
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
 * - **负向记忆**：一次无过滤全量拉取的返回值即该时刻 btw 全集（session.list 的 surface
 *   查询枚举注册表、不分页），其中未出现、且此前已补充拉取确认过的 id 判为「已确认非线」，
 *   后续判别直接返回 false、不再触发全量拉取。没有它时主会话与每个 subagent 会话每结束
 *   一个 turn 都落空一次并发起一次全量 RPC（在途去重只能折叠并发、折叠不了连续调用），
 *   未读标记与完成提示音还被推迟一个 RPC 往返。负向记忆只被「相反证据」清除——后续全量
 *   拉取或 merge 喂入返回该 id 即它是线（出负向表，进正向缓存）；不凭时间过期，拉取失败
 *   不写负向记忆（显式未知，保留补充拉取口径，由调用方按「当次不抑制」处置）。
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

/**
 * 负向缓存：已被一次完整全量拉取确认「非线」的 session id 集合。
 *
 * @data-owner #77 —— btw 线成员判别拉取缓存的负向侧（与上方 knownLines 同属一条登记、
 * 同一次拉取事实的反向结论；权威源 = runtime 会话注册表 surface 事实，经 session.list
 * {surface:'btw'} 全量拉取的反向结论；写入方 = 本模块 refreshBtwLineMembership /
 * noteBtwLinesPulled / ensureBtwLineMembership 三处内部路径，无第二写方）
 *
 * 为什么单独一张表而不从 knownLines 反推：拉取缓存只装拉取过的线，无法区分「这个 id 不在
 * 全集里」与「这个 id 还没查过」；负向缓存把后者显式排除——只记录真正补充拉取确认过的 id，
 * 新建线（btw.create / fork 产物）因此不会被误判（其 id 首次被查时一定伴随一次当刻拉取，
 * 拉得到即抑制）。surface 终身不可变，故负向结论不会因时间失效，只需被相反证据清除。
 */
const nonLines = new Set<string>()

/** 在途全量拉取（并发去重；null = 当前无在途请求）。 */
let inFlight: Promise<ReadonlySet<string> | null> | null = null

/** 同步读缓存（渲染路径用）：true = 已确认是线；false = 未确认（可能从未拉取过）。 */
export function isKnownBtwLine(sessionId: string): boolean {
  return knownLines.value.has(sessionId)
}

/**
 * 抽屉侧 session.list 拉取产物喂入缓存（merge：抽屉拉取带 mainSessionId 过滤，结果是
 * 全集子集——只增不减，防把其他主会话的线挤出缓存）。
 *
 * 同时清负向缓存：喂入的 id 是当刻拉取事实里的线，此前若被补充拉取判过非线（拉取时序早于
 * 建线）即以相反证据出负向表，后续判别回到「缓存命中即判」。
 */
export function noteBtwLinesPulled(sessionIds: readonly string[]): void {
  if (sessionIds.length === 0) return
  const next = new Set(knownLines.value)
  for (const id of sessionIds) {
    next.add(id)
    nonLines.delete(id)
  }
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
      for (const id of ids) nonLines.delete(id)
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
 * 读取点入口（成员判别）：缓存命中即判；负向缓存命中（已被完整拉取确认非线）即判否、
 * 不再发起全量拉取；其余落空显式补充拉取一次再判，并把「拉取全集之外」写进负向缓存；
 * 拉取失败 = warn + 当次不抑制（返回 false，且不写负向缓存——失败是显式未知，不是
 * 「确认非线」的证据）。返回 true 仅两种来路：缓存命中或补充拉取后确认在线。
 */
export async function ensureBtwLineMembership(sessionId: string): Promise<boolean> {
  if (knownLines.value.has(sessionId)) return true
  if (nonLines.has(sessionId)) return false
  const pulled = await refreshBtwLineMembership()
  if (pulled === null) return false
  if (pulled.has(sessionId)) return true
  nonLines.add(sessionId)
  return false
}

/** 测试隔离：清空缓存与在途态（生产代码禁止调用）。 */
export function __resetBtwLineMembershipForTest(): void {
  knownLines.value = new Set()
  nonLines.clear()
  inFlight = null
}
