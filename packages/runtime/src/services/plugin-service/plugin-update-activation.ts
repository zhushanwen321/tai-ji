/**
 * R-1 更新链激活语义（2026-10-24 裁决，缺陷 2：更新后旧模块代码不生效）
 *
 * 根因链：assignProcess 对存活 fork 恒命中复用分支（M6a-06：deactivate 不 terminate）
 * + plugin-bootstrap.handleLoad 按 URL `await import` 命中 ESM 模块缓存——更新只换
 * 目录内容不换进程，重激活重放旧模块。两个结果：S26「插件重激活执行新代码」失效；
 * 激活必败包静默落盘（激活失败判定因新代码从不执行而不成立），S18 更新回滚不可达。
 *
 * 修复 = 进程即模块边界：换入成功后先终结旧 sandbox fork 再激活（换新进程即换新
 * 模块缓存）。两函数从 PluginService.commitAndActivate 抽出（max-lines 拆分先例，
 * 行为与顺序不变）。真 fork 终验归真机 a26 剧本（更新后 PID 变化 / displayName 切新 /
 * 必败包报 plugin-install-error）；机制断言 = plugin-installer.test.ts R-1 三用例。
 */

import type { PluginHost } from './plugin-host.js'
import type { PluginActivator } from './plugin-activator.js'
import { toErrorMessage } from '../../utils/errors.js'

/**
 * 换入成功后、激活前终结该插件已存在的 sandbox 子进程（更新场景存在；首装无进程，
 * getWorkerHandle 未命中 no-op）。trusted 共享 Worker 跳过判定镜像 uninstallPlugin
 * （workerId 非 sandbox- 前缀——terminate 会误杀同 worker 其他插件）。
 * 降级策略：终结失败不阻断安装（error 留痕可归因；后续激活大概率复用残留进程 →
 * 旧行为回归，由本日志定位），镜像卸载侧 terminate 失败继续清理语义。
 */
export async function terminateStaleSandboxWorker(host: PluginHost, pluginId: string): Promise<void> {
  const staleHandle = host.getWorkerHandle(pluginId)
  if (staleHandle && staleHandle.workerId.startsWith('sandbox-')) {
    await host.terminateWorker(staleHandle.workerId).catch((err: unknown) => {
      console.error(`[plugin-service] terminate stale sandbox process before re-activation failed for ${pluginId}:`, toErrorMessage(err))
    })
  }
}

/**
 * 回滚分支的进程态收尾：旧沙箱进程已在更新提交段终结，回滚恢复的旧版本目录无进程
 * ——best-effort 重激活旧版本，保 S26「更新失败时旧版本幸存可用」即时成立（新 fork
 * 装旧代码，模块缓存同样干净）。降级策略：重激活失败不再叠加错误面（更新失败已向
 * 上报错），warn 留痕——重启后旧版本按 onStartupFinished 恢复激活。
 */
export async function reactivatePreviousVersionAfterRollback(
  activator: PluginActivator,
  host: PluginHost,
  pluginId: string,
): Promise<void> {
  try {
    await activator.activatePlugin(pluginId, { type: 'onStartupFinished' }, host)
    if (activator.getState(pluginId) !== 'ACTIVE') {
      console.warn(`[plugin-service] rollback re-activation of previous version for ${pluginId} did not reach ACTIVE (recovers on next startup)`)
    }
  } catch (err: unknown) {
    // 降级策略：重激活失败不叠加错误面（更新失败已向上报错），warn 留痕可归因
    console.warn(`[plugin-service] rollback re-activation of previous version for ${pluginId} failed (recovers on next startup):`, toErrorMessage(err))
  }
}
