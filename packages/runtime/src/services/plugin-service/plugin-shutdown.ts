/**
 * PluginService 关停链（D6/W4）——从 plugin-service.ts 迁出（max-lines 拆分，
 * 行为不变）。关停顺序的完整决策注释随代码迁移至此。
 */

import type { PluginHost } from './plugin-host.js'
import type { PluginActivator } from './plugin-activator.js'
import type { SessionDataStore } from './session-data-store.js'
import type { PluginStorage } from './plugin-storage.js'
import type { PluginRpcServer } from './plugin-rpc-server.js'
import type { StatusBarRegistry } from './status-bar-registry.js'
import type { SessionEventDispatch } from './api/session-api.js'
import { toErrorMessage } from '../../utils/errors.js'
import { PendingTracker } from '../../utils/async/pending-tracker.js'

/** 关停链协作者（PluginService 的 8 个私有协作者，经此注入） */
export interface PluginShutdownDeps {
  host: PluginHost
  activator: PluginActivator
  sessionDataStore: SessionDataStore
  storage: PluginStorage
  rpcServer: PluginRpcServer
  statusBarRegistry: StatusBarRegistry
  commandInvokes: PendingTracker<string, unknown>
  sessionEventDispatch: SessionEventDispatch
}

export async function shutdownPluginCollaborators(deps: PluginShutdownDeps): Promise<void> {
  // D6/W3 rebuild 受约束：关停第一步立即关闭 rebuild 通道——deactivateAll 可能耗时
  // 数秒（单插件 deactivate 5s 超时），期间 rebuild 冷却到期会复活插件（LC-C2）。
  // host.shutdown 在链末尾才清，此时已晚。
  deps.host.cancelPendingRebuilds()

  // S3-W1/W2：命令执行 pending 全部拒绝 + session 事件注册表清空
  //（Worker 即将终止，等待中的 executeCommand 与后续事件投递都无意义）。
  deps.commandInvokes.rejectAll(new Error('Plugin service shutting down'))
  deps.sessionEventDispatch.clearAll()

  // S3-W4：statusbar 广播合并窗口的待发 timer 清理（关停后不再广播）
  deps.statusBarRegistry.dispose()

  // D6/W4 关停顺序（反转）：deactivateAll（allSettled，单插件 deactivate 超时不
  // 阻塞整体——每插件自带 DEACTIVATE_TIMEOUT_MS 兜底）→ sessionData flush+dispose
  // → storage flush+dispose → host.shutdown。旧顺序 flush 先于 deactivateAll，
  // 插件在 onDeactivate 里写的 sessionData 落在「表已停」窗口（debounce 500ms 的
  // flush timer 永不再触发）→ 正常关停丢数据（G6）。每步独立 catch：一步失败
  // 不跳过后续步骤（关停是 best-effort 链，错误只记日志）。
  try {
    deps.activator.stopAllWatchers()
  } catch (err: unknown) {
    // best-effort 降级：watcher 清理失败不阻塞关停链（fs 句柄随进程退出释放）
    console.error('[plugin-service] shutdown: stopAllWatchers failed:', toErrorMessage(err))
  }

  try {
    // 插件 onDeactivate 在此执行（其 sessionData/storage 写入发生在后面两步 flush 之前）
    await deps.activator.deactivateAll(deps.host)
  } catch (err: unknown) {
    // best-effort 降级：单步失败继续 flush/dispose，保数据优先于保插件状态
    console.error('[plugin-service] shutdown: deactivateAll failed:', toErrorMessage(err))
  }

  try {
    deps.sessionDataStore.flushAll()
    deps.sessionDataStore.dispose()
    console.log('[plugin-service] shutdown: sessionData flushed and disposed')
  } catch (err: unknown) {
    // best-effort 降级：flush 失败仍继续后续关停（进程即将退出，重试无消费方）
    console.error('[plugin-service] shutdown: sessionData flush/dispose failed:', toErrorMessage(err))
  }

  try {
    deps.storage.flushAll()
    deps.storage.dispose()
  } catch (err: unknown) {
    // best-effort 降级：同上，一步失败不跳过 host.shutdown（Worker/子进程必须终止）
    console.error('[plugin-service] shutdown: storage flush/dispose failed:', toErrorMessage(err))
  }

  try {
    await deps.host.shutdown()
  } catch (err: unknown) {
    // best-effort 降级：Worker/子进程终止失败记日志（进程退出兜底回收）
    console.error('[plugin-service] shutdown: host shutdown failed:', toErrorMessage(err))
  }

  try {
    deps.rpcServer.dispose()
  } catch (err: unknown) {
    // best-effort 降级：注册表清理由进程退出兜底
    console.error('[plugin-service] shutdown: rpcServer dispose failed:', toErrorMessage(err))
  }
}
