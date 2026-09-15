import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { toErrorMessage } from '@zhushanwen/pi-ext-guards'

import { PiSchedulerBackend } from './backend.js'
import { registerScheduleCommand } from './commands.js'
import { importLegacyStore } from './importer.js'
import { SchedulerRuntime } from './runtime.js'
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
import { renderSchedulerWidget } from './widget.js'

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
    const runtime = new SchedulerRuntime(backend, () => sessionGeneration !== myGeneration)
    runtime.loadTasks(backend.loadTasks())
    // W2：tick 后回调刷新 widget（替代独立 widgetTimer + setInterval，节奏对齐 TICK_INTERVAL_MS）
    runtime.onAfterTick(() => refreshWidget(ctx))
    runtime.startScheduler()
    service = new SchedulerService(runtime, () => backend.now())

    // 注册 widget（SDK setWidget 第一重载：直接传 string[]）。初始渲染一次，
    // 后续随每次 tickScheduler 末尾的 onAfterTick 回调刷新（nextRunAt 倒计时 + task 状态）。
    refreshWidget(ctx)
  })

  pi.on('turn_end', () => {
    // IMPORT-FLUSH-GUARD（MF-1）：延迟删除的主触发点——turn_end 前该轮所有 message_end 已持久化
    // （agent-session.js _handleAgentEvent 在 message_end 处理中调 appendMessage 触发 flush），
    // sessionFile 已出现 → cleanup 删 .imported；仍未 flush（无 assistant 消息的轮次）→ 静默保留，
    // 下次 turn_end / session_shutdown 重试。cleanup 幂等（importer.ts importFromFile）。
    importCleanup?.()
  })

  pi.on('session_shutdown', async () => {
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
  })

  // 注册 schedule tool
  // execute 内联闭包：从 SDK 全签名 (toolCallId, params, signal, onUpdate, ctx) 提取 params 转调
  // handler。错误路径 throw（W4）：pi 只对 execute throw 置 isError:true（返回值里的
  // isError 被 agent-loop 丢弃）；getService() 未初始化异常穿透到这里，包装
  // 'Error: Scheduler not initialized' 格式（R3 格式保持）。
  pi.registerTool({
    name: 'schedule',
    label: 'Schedule',
    description: 'Create a scheduled task that fires a message at intervals or cron schedule.',
    parameters: ScheduleParams,
    promptGuidelines: scheduleGuidelines,
    async execute(
      _toolCallId: string,
      params: ScheduleParamsT,
      _signal: AbortSignal | undefined,
      _onUpdate,
      _ctx: ExtensionContext,
    ) {
      try {
        return await handleSchedule(getService(), params)
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

  // 注册 /schedule command。传 getter 而非 service 实例：factory 执行时 service 还是 null。
  registerScheduleCommand(pi, () => service)

  /**
   * 重新计算并推送 scheduler widget（string[] 重载）。
   * 读外层 service 变量而非 getService()：session_start 尚未触发时刷新不应报错，直接跳过。
   */
  function refreshWidget(ctx: ExtensionContext): void {
    if (!service) return
    const result = service.list()
    if (!result.success || !result.data) return
    ctx.ui.setWidget('scheduler', renderSchedulerWidget(result.data.tasks))
  }
}
