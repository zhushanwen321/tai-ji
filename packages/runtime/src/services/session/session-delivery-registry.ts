/**
 * SessionDeliveryRegistry — runtime 侧的 delivery 内核装配 + sessionId 单例注册表。
 *
 * sd-u5（session-manager send 排队）的 runtime 适配器（design.md §3.1 调用方 B）：
 * - payload 能力仅 'text'（runtime 通路拿不到 pi custom message，D9）
 * - isIdle 读 runtime 状态标志（isGenerating / isCompacting / isBashRunning 三者互斥判定）
 * - hasPendingMessages 一期保守 false（端口同步签名拿不到异步 RPC 结果，design.md §5 待验证 1）
 * - subscribeSettled 经组合根 onAgentSettled 多播（index.ts agentSettledListeners）
 * - port.send：ensureActive → skill 注入（A2 MF-C）→ prompt(streamingBehavior) →
 *   成功后 skillNotice 广播 + 置位 + record（D7 保留副作用）
 *
 * 单例约束（§3.4）：同 sessionId 必须复用同一 handle——多 handle 并发投递竞态无保护。
 * sd-u6（完成回流）将复用本注册表，禁止自行 createDelivery。
 */
import { createDelivery } from '@zhushanwen/session-delivery'
import type { DeliveryHandle } from '@zhushanwen/session-delivery'
import type { IPiEngine } from '../ports/pi-engine.js'
import type { IManagedSessionView } from './types.js'
import { LateBoundSkillSource, SkillInjector } from './skill-injector.js'
import { publishSkillNotices } from './skill-notice-publisher.js'
import type { IMessageBus } from '../message-bus/message-bus.js'
import { applySessionOccupancyTransition, userStoppedGate } from './event-interpreter.js'
import { classifyPromptRejection } from './message-dispatcher.js'
import { toErrorMessage } from '../../utils/errors.js'

/** 组合根注入的装配材料（全部窄签名，测试可 mock） */
export interface SessionDeliveryDeps {
  /** 读 session 运行时状态标志（isIdle 判定 + D7 置位副作用） */
  getSession(sessionId: string): IManagedSessionView | undefined
  /** pi 死则 restore 拉起（D7 保留：投递可达性前提） */
  ensureActive(sessionId: string): Promise<IPiEngine>
  /** agent_settled 多播订阅（组合根 agentSettledListeners；返回退订函数） */
  subscribeAgentSettled(cb: (sessionId: string) => void): () => void
  /** 最近工作区记账（D7 保留：best-effort，调用方不感知失败） */
  recordWorkspace(cwd: string): void
  /**
   * MessageBus 当前值（[A2 D-A2-2] skillNotice 广播用；与 SessionRecordsDeps 同款
   * getter 晚期注入语义，返回 null → notice 发布 no-op，注入文本处理照常）。
   */
  getMessageBus(): IMessageBus | null
}

/** 注册表对外接口（SessionManagerHandler 经此消费 delivery 能力） */
export interface SessionDeliveryRegistry {
  /** 同 sessionId 复用同一 handle（单例约束）；factory 仅供测试注入替身 */
  getOrCreateDelivery(sessionId: string, factory?: (sessionId: string) => DeliveryHandle): DeliveryHandle
  /** port 同款直投（handleCreate 初始 prompt：新 session 必 idle 无竞态，不走内核队列，失败照旧 throw） */
  sendDirect(sessionId: string, content: string): Promise<void>
  /**
   * 该 sid 的 delivery 内核是否有未终态投递（排队等待 + 在途投递中 + 错误重试中）。
   * 只读查询（idle pi reclamation D2 #5 豁免信号，u3a）；handle 未创建 / 空队列 → false。
   */
  hasDeliveryActivity(sessionId: string): boolean
  /** 丢弃单 session 队列（session 删除等场景） */
  dispose(sessionId: string): void
  disposeAll(): void
}

/**
 * intent → pi streamingBehavior 的映射表（D3：pi 词汇封闭在适配器内）。
 * streamingBehavior 同时是 runtime 通路的安全网——isIdle 读的是 runtime 侧状态标志，
 * 与 pi 实际 isStreaming 存在 TOCTOU；竞态命中时由 pi 队列兜底（不抛错）。
 */
function toStreamingBehavior(intent: 'interrupt-at-turn-boundary' | 'after-run'): 'steer' | 'followUp' {
  return intent === 'interrupt-at-turn-boundary' ? 'steer' : 'followUp'
}

export function createSessionDeliveryRegistry(
  deps: SessionDeliveryDeps,
  // [A2 D-A2-1] skill 注入器：deliverText 出站前统一处理（与 MessageDispatcher 同款
  // 「默认实例化 + 可替换」形态，测试注入 spy）。[A1 接线] 默认源 = 晚绑定占位
  //（组合根构造 delivery registry 时 registry 已可直传；本默认服务测试装配与
  // server.ts 的退化兜底装配——无标记文本不触达映射）。
  injector: SkillInjector = new SkillInjector(new LateBoundSkillSource()),
): SessionDeliveryRegistry {
  // @data-owner #15（docs/architecture/data-source-registry.md）：sessionId → handle 注册表，
  // handle 内的投递队列 = delivery outbox（内存、非持久，session 删除时 dispose 清空）
  const handles = new Map<string, DeliveryHandle>()

  /**
   * port 层投递原语：ensureActive → inject → 置位 → prompt → notice → D7 副作用。
   * [RT-4#10] 置位先于 prompt（与 sendPrompt 主链 markSessionActive 一致；原「置位晚于
   * prompt 受理」在 RPC 往返窗内呈 idle 且迟到写入把 generating 回退一格）；prompt 失败
   * 按 classifyPromptRejection 分型收口终态（不卡 dispatching）。
   *
   * [A2 MF-C] skill 注入（D-A2-1）：client.prompt 之前。三个消费方（landing 首发直投
   * sendDirect / session_manager send 工具的 agent 构造 prompt / completion-backflow
   * 回流通知）统一行为——字面 `<taiji-skill/>` 标记即展开、无标记 no-op 零 RPC 原文
   * 通过（设计裁决：首发用户内容是注入目标；代理构造/回流模板文本被模仿输出标记时
   * 展开与主链语义一致化，接受）。
   */
  const deliverText = async (
    sessionId: string,
    content: string,
    streamingBehavior?: 'steer' | 'followUp',
  ): Promise<void> => {
    // [session-dead-structural-fixes D4 显式投递清标记（u3b 补线）] 经 runtime delivery 的投递
    // （session_manager send / completion-backflow 回流 / landing 首发直投 sendDirect——三者
    // 全部汇聚于本函数）= 新意图，投递前清 userStopped 标记放行 + 停收敛环。与 sendPrompt
    // 同构：清标记先于 ensureActive/restore（restore-abort 读不到标记即不掐），也先于
    // client.prompt（显式投递开 turn 的 agent_start 事件回流时环已停，不会被收敛环误掐）。
    userStoppedGate.consumeForExplicitDelivery(sessionId)
    const client = await deps.ensureActive(sessionId)
    // [A1 接线] session cwd 作 project 扫描基准（D7）——session 视图缺失时 undefined =
    // global-only 映射（宁缺毋错，不猜 cwd）。
    const injection = await injector.inject(client, content, deps.getSession(sessionId)?.cwd)
    // [RT-4#10] 置位前移至 prompt 之前（原在 prompt 之后）：RPC 往返窗内对预检/回收豁免
    // 呈 idle（TOCTOU 靠 pi 队列兜底），且「prompt 已受理、turn-start 已回流（generating）
    // 后置位把 turn 回退一格 dispatching」投影失真。与 sendPrompt 主链的 markSessionActive
    // （prompt 之前写 'dispatching'）状态机一致。
    const session = deps.getSession(sessionId)
    if (session) {
      applySessionOccupancyTransition(session, deps.getMessageBus(), 'dispatching')
    }
    try {
      await client.prompt(injection.text, undefined, streamingBehavior)
    } catch (e) {
      // [RT-4#10] 前移置位的失败收口（与 sendPrompt 的 handlePromptFailure 同构）：turn 已写
      // 'dispatching'，prompt 抛错必须写终态，否则 occupancy 永卡 dispatching。按
      // classifyPromptRejection 分型——pi busy 类 'processing' 拒绝 = pi 有 runtime 不知情
      // 的 turn 在跑（'reject-processing' 反转 generating）；其余真失败 = 'reject-other' idle。
      if (session) {
        const rejection = classifyPromptRejection(toErrorMessage(e))
        applySessionOccupancyTransition(
          session,
          deps.getMessageBus(),
          rejection === 'processing' ? 'reject-processing' : 'reject-other',
        )
      }
      throw e
    }
    // [A2 D-A2-2] notice 在发送成功后发布（与 dispatcher 时机契约同款）；prompt 失败
    // throw 不发（调用方错误通路覆盖）。
    publishSkillNotices(deps.getMessageBus(), sessionId, content, injection.notices)
    // D7 保留副作用：prompt 受理成功后一并置位（侧栏 working 显示 + lastActiveAt 排序新鲜度）。
    // [session-dead-structural-fixes D2 挂点迁移（u3b）] 原直写 isGenerating=true 是「只写布尔
    // 不写 occupancy」的第三个漂移写点（设计 §2.2 问题一），改调 'dispatching' 行——原语原子
    // 完成 isGenerating=true 派生 + turn='dispatching' 合并 + state 帧广播，与 sendPrompt 的
    // markSessionActive（#1）同构。[RT-4#10] 置位已前移至 prompt 之前，此处只剩 lastActiveAt
    // 与 recordWorkspace 两个非 occupancy 维度副作用（occupancy 写入保留为幂等冗余，防御
    // session 视图在 prompt 窗口内才出现的形态）。
    if (session) {
      session.lastActiveAt = Date.now()
      applySessionOccupancyTransition(session, deps.getMessageBus(), 'dispatching')
      try {
        deps.recordWorkspace(session.cwd)
      } catch (e) {
        // D7 保留：best-effort，失败仅 warn 不传播（isGenerating 已置位不回退）
        console.warn('[session-delivery] workspace.record failed (non-blocking), sid=', sessionId, e)
      }
    }
  }

  const buildHandle = (sessionId: string): DeliveryHandle =>
    createDelivery(
      {
        supportedPayloads: ['text'],
        isIdle: () => {
          const s = deps.getSession(sessionId)
          return !!s && !s.isGenerating && !s.isCompacting && !s.isBashRunning
        },
        // 一期保守（design.md §5 待验证 1，登记表 #15 known-limitation）：同步签名拿不到
        // get_state 的 pendingMessageCount——恒判空使 gate 只剩 isIdle 单条件，依赖 TOCTOU
        // 宽度 + pi 队列兜底；补齐路径 = get_state.pendingMessageCount 异步拉取或 settled 复核
        hasPendingMessages: () => false,
        subscribeSettled: (cb) =>
          deps.subscribeAgentSettled((sid) => {
            if (sid === sessionId) cb()
          }),
        send: (msg, intent) => {
          if (msg.payload.kind !== 'text') {
            // 内核已按 supportedPayloads fail-fast，此为防御性双保险（不静默忽略）
            throw new Error(`[session-delivery] unsupported payload kind: ${msg.payload.kind}`)
          }
          return deliverText(sessionId, msg.payload.content, toStreamingBehavior(intent))
        },
      },
      // 默认意图：turn 边界抢占（D3，F1 教训内化）
      { intent: 'interrupt-at-turn-boundary' },
    )

  return {
    getOrCreateDelivery(sessionId, factory) {
      const existing = handles.get(sessionId)
      if (existing) return existing
      const handle = factory ? factory(sessionId) : buildHandle(sessionId)
      handles.set(sessionId, handle)
      return handle
    },
    sendDirect(sessionId, content) {
      // create 初始 prompt：新 session 必 idle，不传 streamingBehavior（无竞态窗口）
      return deliverText(sessionId, content)
    },
    // D2 #5「delivery 内核有排队投递（completion-backflow 回流）」的只读查询（u3a）。
    //
    // 查询面选择：DeliveryHandle 不暴露 isIdle（isIdle 是注入 createDelivery 的
    // DeliveryPort 成员，registry 拿到的 handle 上不可达），但暴露队列深度查询
    // depth()——文档语义「未终态消息数：等待队列 + 在途（含错误重试中）」，按
    // 「handle 暴露队列状态查询则用之」采用 depth()。
    //
    // 为什么不是「handle 存在即豁免」：handle 是 per-session 单例，生命周期覆盖
    // session 全程（D3 归属表还刻意在回收态保留 sid→handle 映射），存在性恒真会
    // 让回收饿死；depth() > 0 才表示真有投递在途。
    //
    // 为什么不用 buildHandle 的 isIdle 三维标志：那与豁免 #1 occupancy 同源（同读
    // deps.getSession 的三维标志），重复豁免无增量；depth() 恰好覆盖 occupancy 不
    // 覆盖的窗口——session 已空闲但回流消息停在队列/在途投递中（此时回收会杀掉
    // 承接投递的 pi）。
    hasDeliveryActivity(sessionId) {
      const handle = handles.get(sessionId)
      return handle !== undefined && handle.depth() > 0
    },
    dispose(sessionId) {
      handles.get(sessionId)?.dispose()
      handles.delete(sessionId)
    },
    disposeAll() {
      for (const handle of handles.values()) handle.dispose()
      handles.clear()
    },
  }
}
