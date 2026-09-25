/**
 * RevokeOrchestrator — 消息撤回七步编排（message-revoke 设计 §3.3 D2 的 runtime 落点）。
 *
 * 职责：`session.revokeMessage {sessionId, targetId}` 的领域编排——入口同步临界区（置位
 * revoking + 空闲/互斥检查）→ cancel 全部 active（D4）→ 定位 entryId（targetId 双形态
 * 分派）→ 清 history 重建缓存 → 信令前校验（幂等判定 + 顺取 expectedParentId）→
 * sendSystemCommand 触发 pi navigateTree + prompt resolve 后 get_entries 校验 →
 * 派生态失效（校验通过后，时序契约见④段注释）→ reply（D2 ⑦/D7/D8）。
 *
 * 关键契约（注释锚三处——hold 释放 / 末尾锚 / entry.id 集合谓词，见各 inline 注释）：
 * - revoking hold 的置位在编排最前（入口同步临界区内）、释放 = try/finally 全路径；
 * - ③ b 裸标记通道锚定 entry 文本**末尾位置**命中（恒尾附构造）；
 * - ⑥ 校验谓词按回溯链 **entry.id 集合**判定，禁字符串包含判法。
 *
 * 依赖经构造注入（窄接口）：投递内核注册表经 deps.registry（getter 形态——组合根装配序
 * 下注册表晚于编排构造，对齐 SessionDeliveryDeps.getMessageBus 同款晚期读取）；
 * 撤回信号广播腿经 deps.notifyEntryInvalidation（MessageDispatcher.submitToKernel
 * 构造注入收编同款，[MF-1-7] 原进程内活动槽 activeRevocationSignalNotifier 已删除）。
 */
import { BARE_UUID_RE, MSG_ID_TAG_RE, TAIJI_NAV_COMMAND } from '@taiji/shared'
import type { SessionRevokeMessageReply } from '@taiji/shared'
import type { IPiEngine } from '../ports/pi-engine.js'
import type { IManagedSessionView } from './types.js'
import {
  bareMarkerId,
  piContentText,
  type SessionDeliveryRegistry,
} from './session-delivery-registry.js'
import type { SystemCommandOutcome } from './message-dispatcher.js'

/**
 * msg-id-mapper custom entry 的 customType（双侧同构字面量：SSOT 在 extension 源码 +
 * infra/pi/entry-tree-builder.ts 的同名私有常量——本编排领地不含 entry-tree-builder，
 * 自持；形态变更须三侧同步，禁单侧修改）。
 */
const CLIENT_MSG_ID_TYPE = 'taiji.client-msg-id'

/**
 * 撤回失效信号的 customType（双侧同构字面量，域字符串自由域、零 RPC 契约变更）：
 * 与 agent-ext navigateTree 的 LabelEntry label 'taiji:revoked'、scheduler-manager 插件
 * 订阅串三侧同串。组合根经 deps.notifyEntryInvalidation 注入的回调把它转
 * pluginService.notifyEntryInvalidation(sessionId, 本串) 广播给插件 Worker。
 */
export const REVOKED_SIGNAL_CUSTOM_TYPE = 'taiji:revoked'

// 裸 uuid 形态判别（[消息撤回 U8] 保号子形态的分派锚）= @taiji/shared BARE_UUID_RE
// （msg-pipeline-debloat D5-1 收敛：uuid 结构与 MSG_ID_TAG_RE 同源单点构造，原手写体
// 双侧同步纪律随之消灭）。与 pi entryId 的 8 位 hex 形态构造性区分（无连字符不匹配）。

/** 编排依赖（窄注入，测试可 mock；组合根在 session-service 装配）。 */
export interface RevokeOrchestratorDeps {
  /** occupancy 空闲检查数据源（①——三维 turn/compacting/bash 的权威投影）。 */
  getSession(sessionId: string): IManagedSessionView | undefined
  /** pi 拉活（⑤ 数据面 + ⑥ 信令前置交接共用；失败回 pi-reclaimed——D1/A10 无感拉活）。 */
  ensureActive(sessionId: string): Promise<IPiEngine>
  /**
   * workflow running 检查（①——D2 待验证② 落点核实结论：subagent-workflow 内存态在
   * pi 进程内不可同步达，runtime 侧唯一权威通道 = 磁盘 JSONL 扫描（W17 workflow-record
   * entry，run 启动冷路径立即落盘）。异步通道 → 临界区后第一个 await；安全性不依赖
   * 归属——置位先行已封 check-then-act 缝隙，「无 await」只是 occupancy 检查与置位
   * 同段的二层加固（设计 D2 ①原文）。
   */
  hasRunningWorkflow(sessionId: string): Promise<boolean>
  /** history 重建缓存清理（④——Facade evictHistoryRebuildCache 既有入口，复审 F1 核实）。 */
  evictHistoryRebuildCache(sessionId: string): void
  /**
   * 派生态失效（⑥ 树回退校验通过后——注入窄接口：plan-state 等未来状态派生视图失效。
   * 组合根以 no-op 占位实现，U6d 接线点——SessionRecords 丢 cursor 强制全量重建；U6d
   * committed 后替换为真实调用，主 agent 核销该接线点）。调用时点契约：失效经
   * SessionRecords 同步触发 fire-and-forget 全量重算，重算消费调用时点的树快照——
   * 必须后置到树回退确认之后，信令前触发是无效失效（重建消费撤回前数据，见④段注释）。
   */
  invalidateDerivedState(sessionId: string): void
  /**
   * 撤回信号广播腿（[MF-1-7] 窄注入，取代原 activeRevocationSignalNotifier 活动槽）：
   * 树回退确认后转 pluginService.notifyEntryInvalidation(sid, REVOKED_SIGNAL_CUSTOM_TYPE)。
   * 未接线（存量测试构造 / 无插件子系统的装配）时由注入方自降级 no-op。
   */
  notifyEntryInvalidation(sessionId: string): void
  /**
   * 投递内核注册表读取（[MF-1-7] 窄注入，getter 形态——组合根装配序下注册表晚于编排
   * 构造；getter 延迟解析，getter 形态对齐 SessionDeliveryDeps.getMessageBus）。
   * undefined = 组合根未接线 → revokeMessage 显式抛错（fail-fast 语义保持）。
   */
  registry(): SessionDeliveryRegistry | undefined
  /** 系统信令入口（⑥——MessageDispatcher.sendSystemCommand，不经 hook / 不经内核）。 */
  sendSystemCommand(
    sessionId: string,
    commandLine: string,
    requireCommand: string,
  ): Promise<SystemCommandOutcome>
}

/** get_entries entry 的域内宽形态（wire 是 unknown——逐字段守卫后使用，与 registry 的 readTranscriptUserTexts 同款防御口径）。 */
interface RawTreeEntry {
  type?: unknown
  id: string
  parentId: string | null
  message?: { role?: unknown; content?: unknown }
  customType?: unknown
  data?: unknown
}

/** get_entries 快照（③⑤ 共用一次拉取——目标定位与活跃路径校验同一份数据）。 */
interface TreeSnapshot {
  byId: Map<string, RawTreeEntry>
  leafId: string | null
}

/** leafId 沿 parentId 回溯的活跃链（⑥ 校验谓词的数据面）。 */
interface ActiveChain {
  /** 回溯链上的 entry.id 集合（活跃路径投影——谓词按此集合判定，非字符串包含）。 */
  ids: Set<string>
  /** 链自然终止形态（终止于根）= null；expectedParentId === null 时的完备性判定锚。 */
  terminalParentId: string | null
  /** false = parentId 指向缺失 entry / 环（数据断链）——校验不可信，按 nav-failed 处理。 */
  complete: boolean
}

function warn(...args: unknown[]): void {
  console.warn('[revoke-orchestrator]', ...args)
}

/** get_entries → 快照（守卫式解析；失败/形状不符返回 null——调用方按 nav-failed 处理）。 */
async function readTreeSnapshot(client: IPiEngine): Promise<TreeSnapshot | null> {
  try {
    const msg = (await client.getEntries()) as { data?: { entries?: unknown; leafId?: unknown } } | null
    const raw = msg?.data?.entries
    if (!Array.isArray(raw)) return null
    const byId = new Map<string, RawTreeEntry>()
    for (const item of raw) {
      const e = item as { id?: unknown; parentId?: unknown } | null
      if (!e || typeof e.id !== 'string') continue
      byId.set(e.id, {
        ...(e as RawTreeEntry),
        parentId: typeof e.parentId === 'string' ? e.parentId : null,
      })
    }
    const leafId = typeof msg?.data?.leafId === 'string' ? msg.data.leafId : null
    return { byId, leafId }
  } catch (e) {
    warn('get_entries failed:', e)
    return null
  }
}

/** 活跃路径回溯（从 leafId 沿 parentId 到根）。 */
function walkActiveChain(snapshot: TreeSnapshot): ActiveChain {
  const ids = new Set<string>()
  let cur = snapshot.leafId
  while (cur !== null) {
    if (ids.has(cur)) return { ids, terminalParentId: null, complete: false } // parentId 环（数据异常）
    const entry = snapshot.byId.get(cur)
    if (!entry) return { ids, terminalParentId: null, complete: false } // parentId 悬空（断链）
    ids.add(cur)
    cur = entry.parentId
  }
  // cur === null = 链自然终止（初始 leafId 为空的空 session，或根 entry parentId=null）。
  // 终止形态即 terminalParentId = null——「非 null parentId 指向缺失 entry」已在循环内
  // 返回 complete=false，此处无需再区分。
  return { ids, terminalParentId: null, complete: true }
}

/** user message entry → transcript 原文（含投递裸标记，raw 不剥——⑦ D7 分界裁定：剥标记与整批切条在 renderer）。 */
function userEntryText(entry: RawTreeEntry): string {
  if (entry.type !== 'message' || entry.message?.role !== 'user') return ''
  return piContentText(entry.message.content)
}

/**
 * ③ b 通道末尾锚（注释锚②）：真标记恒尾附构造（内核 withDeliveryMarker 对全部投递
 * 消息统一尾附——纯文本同样携带），故锚定「entry 文本末尾位置」命中：用户原文内嵌的
 * 标记字面通常不在末尾，构造性区分；「完美布局的内嵌假标记」极端形态是 D7 层 2 已知
 * 边界（信息论不可分），不在此放宽为全文搜索（会破坏防内嵌误命中设计）。
 */
function endsWithMarkerFor(text: string, bareId: string): boolean {
  const global = new RegExp(MSG_ID_TAG_RE.source, 'gi')
  const want = bareId.toLowerCase()
  for (const m of text.matchAll(global)) {
    const uuid = (m[2] ?? '').toLowerCase()
    if (uuid === want && m.index !== undefined && m.index + m[0].length === text.length) return true
  }
  return false
}

/**
 * ③ 定位目标 entryId（targetId 双形态分派）。原前提「renderer 消息 id 两空间互斥使分派
 * 构造性可靠」被 U8 保号削弱：外来条目 clientUuid 可为裸 uuid 形态（chat store appendUser
 * 无前缀校验），其投递裸标记恰以裸 uuid 落在 transcript——uuid 形态目标（`u-` 前缀或裸
 * uuid 子形态）统一进双通道分派收编，仅 pi entryId（8 位 hex）保持直用：
 * - uuid 形态（`u-` 前缀 live 态 clientUuid / U8 保号裸 uuid）→ 双通道：a) msg-id-mapper
 *   custom entry 映射（富消息；裸 uuid 目标现无映射 entry——mapper 只写 u- 形态，扫过即
 *   miss，兜未来映射面扩展）；b) miss 时 user entry 文本裸标记末尾锚 + uuid ===
 *   bareMarkerId(targetId) 校验（纯文本消息无映射 entry 的主导形态；裸 uuid 经
 *   bareMarkerId 恒等归一后同样命中）。双通道均 miss → null（调用方回 no-mapping）。
 * - 其余形态（基线/重开态 pi entryId，8 位 hex）→ 直接用作 entryId（⑤ 活跃路径校验兜底
 *   语义错误目标——不在全文件即 no-mapping）；content 尽力查取（目标非 user message 时空串）。
 */
function locateTarget(
  snapshot: TreeSnapshot,
  targetId: string,
): { entryId: string; content: string } | null {
  if (targetId.startsWith('u-') || BARE_UUID_RE.test(targetId)) {
    // 通道 a：custom entry 映射（customType 过滤 + data 形状守卫——entry-tree-builder 同款防御）
    for (const entry of snapshot.byId.values()) {
      if (entry.customType !== CLIENT_MSG_ID_TYPE) continue
      const data = entry.data as Partial<{ clientUuid?: unknown; userEntryId?: unknown }> | null | undefined
      if (data && data.clientUuid === targetId && typeof data.userEntryId === 'string') {
        const target = snapshot.byId.get(data.userEntryId)
        if (target) return { entryId: target.id, content: userEntryText(target) }
        // 映射指向的 entry 不在文件（数据断链）→ 落通道 b 继续（b 同样扫不到即 miss）
      }
    }
    // 通道 b：裸标记末尾锚（uuid 双形态归一——MSG_ID_TAG_RE 捕获组 2 恒裸形态）
    const bare = bareMarkerId(targetId)
    for (const entry of snapshot.byId.values()) {
      if (entry.type !== 'message' || entry.message?.role !== 'user') continue
      const text = piContentText(entry.message.content)
      if (text !== '' && endsWithMarkerFor(text, bare)) return { entryId: entry.id, content: text }
    }
    return null
  }
  const direct = snapshot.byId.get(targetId)
  return { entryId: targetId, content: direct ? userEntryText(direct) : '' }
}

/** ① 空闲判定（D8 busy 触发面：isStreaming / isCompacting / settling / isBashRunning）。 */
function isOccupiedForRevoke(view: IManagedSessionView | undefined): boolean {
  if (!view) return false // 无视图（测试/异常装配）按空闲——与 holdReasonOf 同款宽容，后续 ensureActive 失败可见
  const occ = view.occupancy ?? { turn: 'idle' as const }
  return view.isGenerating || view.isCompacting || view.isBashRunning || occ.turn !== 'idle'
}

export class RevokeOrchestrator {
  constructor(private readonly deps: RevokeOrchestratorDeps) {}

  async revokeMessage(sessionId: string, targetId: string): Promise<SessionRevokeMessageReply> {
    const registry = this.deps.registry()
    if (!registry) {
      // 组合根未接线（生产不可达——index.ts 必创建注册表）：显式失败走 error envelope，
      // 不静默降级（「失败要出声」；D8 六码是领域回执不含内部装配错误）
      throw new Error('delivery registry not wired (composition root) — revoke unavailable')
    }
    // ── ① 入口同步临界区（置位先行，封 check-then-act 缝隙）───────────────────────
    // 互斥自检排除自身 = 置位返回值：并发第二撤回在此被挡（回 busy），第一撤回的后续
    // 步骤不会被自身 hold 干扰（sendSystemCommand 不经内核，不受 revoking hold 影响）。
    if (!registry.beginRevokeHold(sessionId)) {
      return { sessionId, revoked: false, error: 'busy' }
    }
    try {
      // ① 空闲检查（同步、无 await——occupancy 三维 turn/compacting/bash）
      if (isOccupiedForRevoke(this.deps.getSession(sessionId))) {
        return { sessionId, revoked: false, error: 'busy' }
      }
      // ① workflow running 检查（临界区后第一个 await——落点见 deps.hasRunningWorkflow 注释）
      if (await this.deps.hasRunningWorkflow(sessionId)) {
        return { sessionId, revoked: false, error: 'workflow-running' }
      }

      // ── ② 内核 active 条目全量 cancel（D4：等价 exclude=全部，走既有 cancel 管道）────
      await this.cancelAllActiveEntries(registry, sessionId)

      // 数据面：拉活 + 一次 get_entries（③⑤ 共用——设计 D2 ③「同一次 get_entries」）。
      // 拉活失败回 pi-reclaimed（A10：无感拉活是常态，失败才是终态码）。
      let client: IPiEngine
      try {
        client = await this.deps.ensureActive(sessionId)
      } catch (e) {
        console.error(`[revoke-orchestrator] ensureActive failed, sid=${sessionId}`, e)
        return { sessionId, revoked: false, error: 'pi-reclaimed' }
      }
      // get_entries 失败归 nav-failed（可重试语义——与 ⑥ 校验读失败同族；重试时若撤回
      // 实际已成功，⑤ 幂等判定兜住不误报 no-mapping）
      const before = await readTreeSnapshot(client)
      if (!before) {
        warn(`nav-failed: pre-signal get_entries read failed, sid=${sessionId}, targetId=${targetId}`)
        return { sessionId, revoked: false, error: 'nav-failed' }
      }

      // ── ③ 定位目标 entryId ─────────────────────────────────────────────────────
      const located = locateTarget(before, targetId)
      if (!located) return { sessionId, revoked: false, error: 'no-mapping' }

      // ── ④ 清 history 重建缓存（惰性清除——下次重建时才读树，无数据时序问题）──────
      // 派生态失效不在此触发（后置到⑥ 校验通过后，见调用点注释）：失效经 SessionRecords
      // 同步触发 fire-and-forget 全量重算，重算消费的是调用时点的树快照——信令前调用时
      // 树尚未回退，无参 getEntries 先于信令到达 pi（同一 client 顺序处理），返回撤回前
      // 快照 → 全量重建派生被撤残影 + cursor 回写撤回前 leafId，信令生效后增量批
      // 「保持基线」→ 残影永续。信令前失效 = 无效失效（时序错位缺陷的根修落点）。
      this.deps.evictHistoryRebuildCache(sessionId)

      // ── ⑤ 信令前校验（用 nav 前数据——放⑥则恒假/恒真皆失效）──────────────────────
      const pre = walkActiveChain(before)
      if (!pre.ids.has(located.entryId)) {
        // 二次判定：目标在全文件存在 → 已被前序撤回带走（含 reply 丢失重试形态）→
        // 幂等回 revoked:true + 原文（重试同样完成 D7 草稿回填闭环）；不存在 → no-mapping。
        // 两分支均不发信令——防复活性跳转（对旧分支目标的 navigateTree 会把叶子挪回去）。
        if (before.byId.has(located.entryId)) {
          // 幂等分支同样触发派生态失效：首次尝试可能已「信令送达 + 树回退、但⑥校验读失败
          // 归 nav-failed」（失效未触发，残影仍在）；重试此刻触发的全量重算消费的已是撤回
          // 后树（时序合法——与⑥′同款后置契约）。
          this.invalidateDerived(sessionId)
          return { sessionId, revoked: true, content: located.content }
        }
        return { sessionId, revoked: false, error: 'no-mapping' }
      }
      // 顺取 M.parentId = expectedParentId（append-only 文件中不可变，时序安全——唯一取数点）
      const expectedParentId = before.byId.get(located.entryId)?.parentId ?? null

      // ── ⑥ 信令 + prompt resolve 后校验 ──────────────────────────────────────────
      const outcome = await this.deps.sendSystemCommand(
        sessionId,
        `/${TAIJI_NAV_COMMAND} ${located.entryId}`,
        TAIJI_NAV_COMMAND,
      )
      if (outcome.kind === 'extension-missing' || outcome.kind === 'pi-reclaimed') {
        return { sessionId, revoked: false, error: outcome.kind }
      }
      if (outcome.kind === 'error') {
        // prompt 传输级失败：无法确认树状态——nav-failed（重试安全：⑤ 幂等判定兜住）
        warn(`nav-failed: nav command transport error, sid=${sessionId}, targetId=${targetId}, entryId=${located.entryId}, message=${outcome.message}`)
        return { sessionId, revoked: false, error: 'nav-failed' }
      }
      // [post-signal 防御性失效] 以下三个 nav-failed 分支（校验读失败 / 活跃链断裂 /
      // parentReached 不过）的共同前提：nav 信令已送达 pi（sendSystemCommand 已 resolve），
      // 树可能已实际回退而校验未能确证——三处均补派生态失效。失效幂等：树未回退时全量
      // 重算消费未变树，收敛到同态零副作用；已回退时立即按撤回后树清残影，不等用户重试
      // （重试前存在残影窗口）。与⑥′的差别 = 时机证据强度：⑥′是树回退确证后的失效，
      // 此处是不确定态的防御性失效。
      const after = await readTreeSnapshot(client)
      if (!after) {
        warn(`nav-failed: post-signal get_entries read failed, sid=${sessionId}, targetId=${targetId}, entryId=${located.entryId}`)
        this.invalidateDerived(sessionId)
        return { sessionId, revoked: false, error: 'nav-failed' }
      }
      const post = walkActiveChain(after)
      if (!post.complete) {
        warn(`nav-failed: active chain broken/cyclic after rewind, sid=${sessionId}, targetId=${targetId}, entryId=${located.entryId}, expectedParentId=${expectedParentId}`)
        this.invalidateDerived(sessionId)
        return { sessionId, revoked: false, error: 'nav-failed' }
      }
      // 谓词（注释锚③）：按回溯链 entry.id 集合判定，禁序列化字符串包含判法——
      // LabelEntry.targetId 字段指向被撤消息，字符串包含判法会误报「路径仍含目标」。
      if (post.ids.has(located.entryId)) {
        // 此分支刻意不失效（与上方三分支相反）：目标仍在活跃链 = 树确证未回退（回退后
        // 目标必不在活跃链），无残影产生——树未回退时失效收敛到同态，纯冗余调用；
        // nav-failed 语义 = 本轮未完成，重试走⑤正常路径。
        warn(`nav-failed: target still on active path after rewind, sid=${sessionId}, targetId=${targetId}, entryId=${located.entryId}`)
        return { sessionId, revoked: false, error: 'nav-failed' }
      }
      const parentReached =
        expectedParentId === null ? post.terminalParentId === null : post.ids.has(expectedParentId)
      if (!parentReached) {
        warn(`nav-failed: expected parent not reached after rewind, sid=${sessionId}, targetId=${targetId}, entryId=${located.entryId}, expectedParentId=${expectedParentId}, terminalParentId=${post.terminalParentId}`)
        this.invalidateDerived(sessionId)
        return { sessionId, revoked: false, error: 'nav-failed' }
      }

      // ── ⑥′ 派生态失效（树回退确认后——时序契约见④段注释）：此刻触发的全量重算
      // 消费撤回后树，被撤派生（plan 残影等）随活跃路径裁剪收敛清除。
      this.invalidateDerived(sessionId)

      // ── ⑦ reply：revoked:true + transcript 原文（含投递裸标记，raw 不剥）──────────
      return { sessionId, revoked: true, content: located.content }
    } finally {
      // ── revoking hold 释放（注释锚①——D2 硬契约）─────────────────────────────────
      // try/finally 覆盖①-⑦全部路径含 busy / workflow-running / no-mapping /
      // pi-reclaimed / nav-failed 提前 return：泄漏形态 = 该 session 后续提交永久
      // queued 死轮询（恢复通道仅重启 app）。幂等（dispose 已清场时 no-op）。
      registry.endRevokeHold(sessionId)
    }
  }

  /**
   * 派生态失效 + 撤回信号广播（恒配对入口——全部失效点唯一走此处，结构性杜绝单腿）：
   * SessionRecords 全量重算腿（invalidateDerivedState）与插件镜像重建腿（经
   * deps.notifyEntryInvalidation 注入回调广播 REVOKED_SIGNAL_CUSTOM_TYPE）消费同一
   * 「活跃路径已变更」事实，只失效 records 腿会
   * 复现 scheduler-manager 面板残留缺陷（插件镜像折叠输入含被撤子树 op）。调用点 =
   * ⑤ 幂等分支 + ⑥ post-signal 三防御分支 + ⑥′ 确认点——均为树回退已确认或防御性
   * 不确定态，广播的镜像重建幂等（重拉经 readEntries 活跃路径过滤，树未回退时收敛到
   * 同态）。「目标仍在活跃链」分支刻意双双不调用（树确证未回退，无残影产生）。
   */
  private invalidateDerived(sessionId: string): void {
    this.deps.invalidateDerivedState(sessionId)
    this.deps.notifyEntryInvalidation(sessionId)
  }

  /**
   * ② 内核 active 条目全量作废（D4）：空闲前置（①）下内核 active 条目必然晚于撤回点
   * 提交（早于 M 的已按 FIFO 先行 drain），无需位置感知——逐条走既有 cancel 管道
   * （等价 exclude=全部）。
   *
   * 草稿抑制（D2 ②）：cancel 管道的草稿回填通道 = delivery.cancel RPC reply 的 content
   * 字段——编排直调 registry.cancel 不产生该 reply，被作废条目的原文回填结构性不发生
   * （撤回 reply 只带 M 原文，草稿终态唯一焦点 = M，防双回填竞争）。降级整批形态不在此
   * 处理（整批 entry 同一管道 cancel，切条还原归 renderer D7 两层规则）。
   *
   * 单条失败不阻断撤回主链：不可撤形态（已进 transcript 的「已投递不可撤」）随树回退
   * 移出活跃路径，无害——warn 留痕（非静默吞）。
   */
  private async cancelAllActiveEntries(registry: SessionDeliveryRegistry, sessionId: string): Promise<void> {
    const ids = (registry.entries(sessionId)?.active ?? []).map((e) => e.id)
    for (const id of ids) {
      try {
        const outcome = await registry.cancel(sessionId, id)
        if (!outcome.cancelled) {
          warn(`active entry not cancelled (delivered form leaves active path via tree rewind), sid=${sessionId}, id=${id}, reason=${outcome.reason ?? 'unknown'}`)
        }
      } catch (e) {
        warn(`active entry cancel threw (continuing), sid=${sessionId}, id=${id}`, e)
      }
    }
  }
}
