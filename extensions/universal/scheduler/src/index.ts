import type { ExtensionAPI, ExtensionContext, TurnEndEvent } from '@earendil-works/pi-coding-agent'
import type { GuiContext } from '@zhushanwen/extension-protocol'
import { toErrorMessage } from '@zhushanwen/pi-ext-guards'
import { getLogger } from '@zhushanwen/pi-extension-logger'

import { createAckTurnController, type AckTurnController } from './ack-turn.js'
import { PiSchedulerBackend } from './backend.js'
import { registerScheduleCommand } from './commands.js'
import { formatSchedule } from './format.js'
import { MS_PER_MINUTE } from './parsing.js'
import { readUiLocale, t } from './i18n.js'
import { importLegacyStore } from './importer.js'
import { abortPendingScheduleForms } from './interaction.js'
import { SchedulerRuntime, type SchedulerModelOps } from './runtime.js'
import { SchedulerService } from './service.js'
import {
  controlGuidelines,
  handleSchedule,
  handleScheduleControl,
  ScheduleControlParams,
  type ScheduleControlParamsT,
  scheduleGuidelines,
  ScheduleParams,
  type ScheduleParamsT,
} from './tool.js'
import { computeTasksFingerprint, setSchedulerWidget } from './widget.js'
import type { ScheduledTask } from './types.js'

// G1（代际检测，S9/R3-M1）：session 代际计数器。必须声明在模块级而非 factory 体内：
// pi 每次 session 替换（newSession/fork/switchSession）都重跑 extension factory 函数体
// （loader.ts loadExtension 无条件 `await factory(api)`；extensionCache 只缓存 factory
// 函数对象、不缓存执行结果）——闭包级声明每次重跑即重置，各代 runtime 的 isCtxStale 恒
// false（R3 实测证伪的回归）。模块级声明下，extensionCache 命中期间（同 cwd 未 reload）
// factory 是同一函数对象、共享同一模块环境绑定，计数器跨 factory 重跑保留递增：新闭包的
// session_start 递增本计数器，各代 runtime 构造时捕获的代数从此小于模块值 → isCtxStale
// 生效——stale 分诊不依赖 pi 错误文案（Error message 非契约 API，pi 升级改文案即静默失效）。
//
// 残余盲区（reload）：显式 reload / cwd 变化触发 clearExtensionCache → jiti 重新 import
// （moduleCache:false）产生全新模块环境，本计数器随新环境重置；旧闭包引用的是旧模块环境的
// 绑定，永不再递增 → 其 isCtxStale 恒 false。该盲区由两道既有防线覆盖：pi 在替换前 await
// fire session_shutdown（F1 stopScheduler 主防线，teardownCurrent）+ runtime 侧
// STALE_CTX_MARKER 文案兜底（F2 catch 分诊）。
let sessionGeneration = 0

/** 包内既有 logger（ack 编排的日志面与其它模块同源）。 */
const logger = getLogger('scheduler')

/**
 * D2 保活底线帧间隔（10min）：任务集静态期间每 ≥10min 强制推一帧（内容与上一帧相同，
 * 纯粹为维持 rpc-client 入站全帧 touch `_lastActivityAt` 的心跳），防 idle reaper
 * （DEFAULT_PI_RECLAIM_IDLE_MS，生产 2h，5min 一拍、严格大于判定）回收挂有定时任务的
 * 会话——定时任务跨空闲期不停摆（G3）。
 *
 * **方案不变量：保活间隔 ≪ idle 回收阈值，须维持 ≥3 倍余量。** 生产 10min vs 2h = 12 倍；
 * 保活帧实际到达受 tick（TICK_INTERVAL_MS=30s）驱动波动（+0~30s），余量须覆盖 tick 波动
 * 与 reaper 拍相位。未来调整本值、idle 阈值或 tick 间隔任一侧，须重验 ≥3 倍余量并重跑
 * C-场景（真机加速验收的加速值也须 ≥3 倍保活间隔，防零余量竞态随机误回收）。
 */
/** 保活间隔的分钟数（语义单位，避免裸魔数；乘 MS_PER_MINUTE 得毫秒间隔）。 */
const WIDGET_KEEPALIVE_MINUTES = 10
const WIDGET_KEEPALIVE_INTERVAL_MS = WIDGET_KEEPALIVE_MINUTES * MS_PER_MINUTE

/**
 * pi-scheduler extension factory。
 * 注册 schedule + schedule_control 两个 tool、/schedule command、session 事件。
 *
 * service 生命周期：在 session_start 中创建（依赖 ctx），factory 顶层只声明为 null。
 * tool/command 的 execute/handler 通过 getService() 延迟读取，避免在 factory 顶层
 * 捕获 null——那时 session_start 尚未触发，service! 非空断言会骗过编译器但运行时是 null。
 */
export default function schedulerExtension(pi: ExtensionAPI): void {
  let service: SchedulerService | null = null
  // IMPORT-FLUSH-GUARD（MF-1）：importLegacyStore 对未 flush 的新 session 返回延迟删除 .imported
  // 的 cleanup——turn_end / session_shutdown 时执行：确认 flush（sessionFile 已出现）则删，
  // 未 flush 保留供崩溃恢复重导入（否则未 flush 即退出 → 全部旧任务丢失且源文件已销毁）。
  // 触发点用 turn_end（而非仅 session_shutdown）：turn_end 时该轮 message_end 已全部持久化
  // （flush 必已发生），把跨 session 双导入窗口从「session 整个生命周期」缩回
  // 「session_start → 首个 turn_end」秒级。cleanup 幂等（importer.ts importFromFile），重复调用安全。
  let importCleanup: (() => void) | undefined
  // ack 确认轮控制器（u-ack-turn）：per-session 实例（backend 每代新建），但状态住
  // ack-turn 的模块级单例——新代构造后即接管并清理上一代残留。
  let ackController: AckTurnController | null = null
  // D1 指纹跳推 + D2 保活底线帧的推送状态（scheduler widget 推送修正设计 D1-b/D2）。
  // **必须声明在 factory 闭包内（extension 实例态），禁模块级**：模块级跨 session 残留会让
  // 新会话继承旧会话的指纹/时间戳——session_start 的首帧（含清屏帧）被跳推，widget 面板
  // 空窗；模块级 vs 闭包级的语义差异在本包有实证（见上方 sessionGeneration 注释）。
  // 生命周期：session_start 装配新会话实例时重置（refreshWidgetState 调用点）。
  let lastWidgetFingerprint: string | null = null
  let lastWidgetPushedAt = 0

  const getService = (): SchedulerService => {
    if (!service) throw new Error('Scheduler not initialized: session not started')
    return service
  }

  pi.on('session_start', (_event, ctx: ExtensionContext) => {
    // G1：先递增模块级代数再装配——自此同模块环境内所有前代 runtime 的 isCtxStale 返回
    // true（stale）。myGeneration 是本 handler 的代数，注入的比对闭包读实时模块级
    // sessionGeneration 与之比较（factory 重跑的新闭包与本闭包共享同一模块绑定）。
    sessionGeneration += 1
    const myGeneration = sessionGeneration
    // F1（治本）：session 替换/重入时先停上一代 runtime 的 tick interval——dispatch 的 await sendMessage
    // 窗口与 session 替换交错时旧 session_shutdown 可能永远等不到（timer 泄漏源头）。stopScheduler 幂等，
    // shutdown 已停过再停一次无副作用。
    service?.runtime.stopScheduler()
    // 装配点：backend（ctx.sessionManager 读 entries / pi.appendEntry 写 op）→ runtime（内存态 + 调度）→ service（业务入口）
    const backend = new PiSchedulerBackend(ctx, pi)
    // 旧 store 原子导入（CL3 方案A）：必须在 backend.loadTasks() 之前执行——
    // append 的 upsert entry 进入 pi 内存 fileEntries，紧接的 loadTasks replay 统一重放读到导入任务。
    // ctx.cwd 类型为 string（SDK ExtensionContext 必填），无需 ?? process.cwd() 兜底（CL2）。
    importCleanup = importLegacyStore(ctx.cwd, pi, ctx.sessionManager.getSessionFile())

    // G1：注入代际比对（本 runtime 建立时的代数 vs 实时代数），供 tick 前置检查与
    // F2 catch 分诊判定 stale——不依赖 pi 错误文案。
    // 投递模型（scheduler-steer-direct-dispatch）：到期任务 steer 直投（backend.sendMessage），
    // 受理即记账，不经投递内核。
    // U4 模型控制面（设计 D3）：runtime 只见 'provider/id' ref（与 task.model 同域），pi 的
    // Model 对象解析封在本闭包。setModelByRef 契约 = 不 throw、失败返回 false（ref 非法 /
    // modelRegistry.find 无命中 / pi setModel false / 意外异常统一折叠）。
    const modelOps: SchedulerModelOps = {
      getCurrentModelRef: () => {
        const m = ctx.model
        return m ? `${m.provider}/${m.id}` : undefined
      },
      setModelByRef: async (ref: string) => {
        try {
          const slash = ref.indexOf('/')
          if (slash <= 0 || slash === ref.length - 1) return false
          const model = ctx.modelRegistry.find(ref.slice(0, slash), ref.slice(slash + 1))
          if (!model) return false
          return await pi.setModel(model)
        } catch {
          return false
        }
      },
      isIdle: () => ctx.isIdle(),
    }
    const runtime = new SchedulerRuntime(backend, () => sessionGeneration !== myGeneration, modelOps)
    runtime.loadTasks(backend.loadTasks())
    // W2：tick 后回调刷新 widget（替代独立 widgetTimer + setInterval，节奏对齐 TICK_INTERVAL_MS）
    runtime.onAfterTick(() => refreshWidget(ctx))
    runtime.startScheduler()

    // ack 确认轮装配（u-ack-turn）：构造后立刻调 handleSessionBoundary——它是 session_start
    // 与 session_shutdown 共用的边界清理：做一次写盘判定并注销上一代残留的覆写窗口
    // （模块级单例跨代共享的结构性意义）。
    ackController = createAckTurnController({
      backend,
      log: logger,
      render: (key, params) => t(key, params),
      notify: (message, level) => ctx.ui.notify(message, level),
      // 已注册 provider 查询（ack no-base 判据②）：闭包捕获本 session 的 modelRegistry——
      // getRegisteredProviderIds 返回 native 重载层 ∪ 扩展注册层两层并集，任一层命中即
      // no-base（覆写会顶掉注册且 unregister 两层同删不恢复，第三方经任一层注册的
      // provider 不能被 ack 静默删除）。
      isProviderRegistered: (providerId) =>
        ctx.modelRegistry.getRegisteredProviderIds().includes(providerId),
    })
    ackController.handleSessionBoundary()

    service = new SchedulerService(runtime, () => backend.now(), (task) => {
      // 创建汇聚点 → ack 触发器（fire-and-forget：回调不 await，失败仅日志面）。
      // 唯一生产开关 TAIJI_SCHED_ACK_DISABLE 在此单点读取（fail-safe 方向：缺省不禁用）。
      const controller = ackController
      if (!controller) return
      void controller
        .maybeStartAck({
          task: {
            id: task.id,
            name: task.name,
            scheduleText: formatSchedule(task.schedule, task.kind, readUiLocale()),
          },
          model: backend.getCurrentModel(),
          isIdle: backend.isIdle(),
          isToggleDisabled: process.env.TAIJI_SCHED_ACK_DISABLE === '1',
        })
        .catch(err => logger.warn('ack turn failed', { error: toErrorMessage(err) }))
    })

    // 注册 widget（SDK setWidget 第一重载：直接传 string[]）。初始渲染一次，
    // 后续随每次 tickScheduler 末尾的 onAfterTick 回调刷新（推送频率由指纹跳推 +
    // 保活底线帧判定，见 refreshWidget）。
    // 新会话实例起点重置推送状态：首帧（含空任务清屏帧）必推，不继承前代指纹/时间戳。
    lastWidgetFingerprint = null
    lastWidgetPushedAt = 0
    refreshWidget(ctx)
  })

  // turn_end 单注册共用（U4 恢复挂点与 MF-1 cleanup 同事件）：真实 pi 的 on 是 handler 列表
  // 追加，但测试仿真 mock 为覆盖式单 handler，且同事件单注册与「listener 防重复注册」纪律一致。
  pi.on('turn_end', (event?: TurnEndEvent) => {
    // IMPORT-FLUSH-GUARD（MF-1）：延迟删除的主触发点——turn_end 前该轮所有 message_end 已持久化
    // （agent-session.js _handleAgentEvent 在 message_end 处理中调 appendMessage 触发 flush），
    // sessionFile 已出现 → cleanup 删 .imported；仍未 flush（无 assistant 消息的轮次）→ 静默保留，
    // 下次 turn_end / session_shutdown 重试。cleanup 幂等（importer.ts importFromFile）。
    importCleanup?.()
    // U4 dispatch 模型切换恢复挂点（设计 D3 修订版）：状态机、恢复动作与 stale 代际守卫都在
    // SchedulerRuntime。`event?.` 容错：pi 契约 payload 恒在，测试仿真可无参调用，缺省不匹配不动作。
    service?.runtime.handleTurnEnd(event?.turnIndex)
    // ack 安全网注销（幂等）：正常路径已在 streamSimple 调用点自撤，这里覆盖「覆写未被调用」
    // 的轮次（E2）。
    ackController?.handleTurnEnd()
  })

  // U4 dispatch 模型切换：归属状态机其余事件监听（P-MODEL-③④ 实测序态）。handler 只转发
  // 事件数据；agent_settled = run 完全沉降（无 retry/compaction/queued continuation）后的
  // 窗口封口 + awaiting-restore 模型恢复的即时兑现（区别于 agent_end 的纯封口）。
  pi.on('agent_start', () => service?.runtime.handleAgentStart())
  pi.on('turn_start', (event) => service?.runtime.handleTurnStart(event?.turnIndex))
  pi.on('message_start', (event) => {
    service?.runtime.handleMessageStart(event?.message)
    // ack 触发器判别（u-ack-turn）：只有我们注入的 custom 消息（前缀 pi-scheduler-ack:）
    // 才同步武装覆写；外来/assistant 消息一律忽略。
    ackController?.handleMessageStart(event?.message)
  })
  pi.on('agent_end', () => service?.runtime.handleRunClosed())
  // agent_settled 除封口外兼作 awaiting-restore 模型恢复的即时兑现挂点（不与 agent_end
  // 共用：end 后仍可能有自动续跑 turn，此时切回会把续跑 turn 的模型换掉，见
  // runtime.handleRunSettled 注释）
  pi.on('agent_settled', () => service?.runtime.handleRunSettled())

  pi.on('session_shutdown', async () => {
    // 命令路径挂起表单的收口（设计 §6.2 生命周期案 ①②③）：session_shutdown
    //（reason ∈ quit/reload/new/resume/fork）→ abort 挂起的表单交互（不创建、不 toast）。
    // taiji 内「切到另一会话」不触发本事件，表单保留且仍有效（有意行为）。
    abortPendingScheduleForms()
    // append-only 模型无 persistSync（runtime 已按 op appendEntry 落盘到 owner session JSONL）；
    // widgetTimer 已移除（由 runtime.onAfterTick 替代）。仅停止 scheduler tick。
    if (service) {
      service.runtime.stopScheduler()
    }
    // IMPORT-FLUSH-GUARD（MF-1）：兜底清理——正常路径已由首个 turn_end 完成；此处覆盖
    // 从未产生 turn 的 session（打开未发消息即关闭）。cleanup 确认 flush（sessionFile 已出现）
    // 则删 .imported，未 flush 保留供崩溃恢复重导入
    try {
      importCleanup?.()
    } finally {
      // MF-2：cleanup 抛非 ENOENT 错误（如 EACCES）也必须复位，避免残留闭包
      importCleanup = undefined
    }
    // ack 边界清理（u-ack-turn）：先做写盘判定再自撤覆写并全量清状态（含取消上一代 30s
    // 定时器）—— session_start 与 session_shutdown 共用，跨代单例的结构性意义。
    ackController?.handleSessionBoundary()
  })

  // 注册 schedule tool（触发反转：直建，不再弹确认表单——人侧表单入口在 /schedule 命令）。
  // execute 内联闭包：从 SDK 全签名 (toolCallId, params, signal, onUpdate, ctx) 提取
  // 转调 handleSchedule 直建流（预校验 → abort 检查 → service.create）。
  // 错误路径 throw（W4）：pi 只对 execute throw 置 isError:true（返回值里的
  // isError 被 agent-loop 丢弃）；getService() 未初始化异常穿透到这里，包装
  // 'Error: Scheduler not initialized' 格式（R3 格式保持）。
  pi.registerTool({
    name: 'schedule',
    label: 'Schedule',
    description:
      'Create a scheduled task that fires a message at intervals or cron schedule. ' +
      'The task is created immediately (no confirmation form). Call it only when the user ' +
      'has already expressed the timing; if the timing or the reminder content is missing ' +
      'or ambiguous, clarify with the user first — never guess a schedule. The task only ' +
      'fires while this session stays open. The response includes the task id and next run ' +
      'time(s); repeat them back to the user so the task is easy to verify or undo.',
    parameters: ScheduleParams,
    promptGuidelines: scheduleGuidelines,
    async execute(
      _toolCallId: string,
      params: ScheduleParamsT,
      signal: AbortSignal | undefined,
      _onUpdate,
      _ctx: ExtensionContext,
    ) {
      try {
        return await handleSchedule(getService(), params, signal)
      } catch (err) {
        throw new Error(`Error: ${toErrorMessage(err)}`)
      }
    },
  })

  // 注册 schedule_control tool（错误路径同上：throw 让 pi 置 isError）
  pi.registerTool({
    name: 'schedule_control',
    label: 'Schedule Control',
    description: 'Manage scheduled tasks: list, toggle, delete, or run immediately.',
    parameters: ScheduleControlParams,
    promptGuidelines: controlGuidelines,
    async execute(
      _toolCallId: string,
      params: ScheduleControlParamsT,
      _signal: AbortSignal | undefined,
      _onUpdate,
      _ctx: ExtensionContext,
    ) {
      try {
        return await handleScheduleControl(getService(), params)
      } catch (err) {
        throw new Error(`Error: ${toErrorMessage(err)}`)
      }
    },
  })

  // 注册 /schedule 命令。传 getter 而非 service 实例：factory 执行时
  // service 还是 null。
  registerScheduleCommand(pi, () => service)

  /**
   * 重新计算并推送 scheduler widget（双模：GUI 结构化 meta + TUI 文本行）。
   * 读外层 service 变量而非 getService()：session_start 尚未触发时刷新不应报错，直接跳过。
   * `ctx as GuiContext`：pi 的 `ExtensionContext` 与协议包最小结构（mode/hasUI/ui.setWidget）
   * 静态不完全兼容，先例见 todo/src/index.ts makeRefreshDisplay。
   *
   * 推送频率判定（scheduler widget 推送修正设计 D1-b / D2）：
   * - D1 指纹跳推：任务集稳定指纹（computeTasksFingerprint，字段集含 kind/locale）与上次
   *   实际推送相同且保活未到期 → 跳过推送。时间流逝不是状态变化，任务集不变期间零推送
   *   （rpc/tui 两模式同效——判定在 setWidgetDual 之前）。
   * - D2 保活底线帧：有任务（任务集非空，含全部 disabled——任务存在即调度意图，re-enable
   *   后须可执行）且距上次实际推送超过 WIDGET_KEEPALIVE_INTERVAL_MS → 强制推一帧（内容
   *   与上帧相同，纯粹为维持心跳防 idle reaper 回收）。空任务集不发保活帧：清屏后任务集
   *   保持空 → 无帧 → 会话按 idle 规则正常回收（保活与任务存在性绑定）。
   * - fail-open：指纹计算异常即推送（宁可多推不可漏显，设计 §3.1 失败路径）。
   */
  function refreshWidget(ctx: ExtensionContext): void {
    if (!service) return
    const result = service.list()
    if (!result.success || !result.data) return
    const tasks: ScheduledTask[] = result.data.tasks
    const locale = readUiLocale()

    let fingerprint: string
    try {
      fingerprint = computeTasksFingerprint(tasks, locale)
    } catch (err) {
      // fail-open（辅助显示面的降级 ≠ 吞错）：指纹异常说明序列化路径有 bug，跳推判定不可信
      // → 直接推送保显示正确；缓存失效（null）使下一帧也必推，保活计时照常刷新。
      logger.warn('widget fingerprint computation failed, pushing anyway', { error: toErrorMessage(err) })
      lastWidgetFingerprint = null
      lastWidgetPushedAt = Date.now()
      setSchedulerWidget(ctx as GuiContext, tasks)
      return
    }

    const nowMs = Date.now()
    // D2 双条件：任务存在（含 disabled）+ 距上次实际推送超时。跳推不刷新 lastWidgetPushedAt
    // ——保活计时只从「实际推送」起算。
    const keepaliveDue = tasks.length > 0 && nowMs - lastWidgetPushedAt >= WIDGET_KEEPALIVE_INTERVAL_MS
    if (fingerprint === lastWidgetFingerprint && !keepaliveDue) return

    setSchedulerWidget(ctx as GuiContext, tasks)
    lastWidgetFingerprint = fingerprint
    lastWidgetPushedAt = nowMs
  }
}
