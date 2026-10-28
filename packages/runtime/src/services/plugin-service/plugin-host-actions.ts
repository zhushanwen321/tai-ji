/**
 * 插件宿主动作原语（provider-plugin-access D8 / D9 的宿主侧出口族）。
 *
 * 从 PluginService facade 拆出的「输入 / 输出动作」实现（facade 的 max-lines 软上限被
 * D8/D9/U5 的装配方法推近阈值；这些动作不是编排状态，拔出后 facade 只留 IPluginService
 * 门面与依赖装配）：
 *  - deliverUiEventToPlugin：renderer 输入值回传 → 渲染该树的插件 Worker（单向通知，D8）；
 *  - createPluginEventIdGenerator：plugin:event 广播 id 单调计数（Date.now 同毫秒碰撞面，D9）；
 *  - openUrlInSystemBrowser：宿主系统浏览器唤起（scheme 白名单校验在 rpc-setup 入口，D9）。
 */
import { execFile } from 'node:child_process'
import { buildOutboundChildEnv } from '../../infra/spawn-env.js'
import { toErrorMessage } from '../../utils/errors.js'
import { PLUGIN_UI_EVENT_NOTIFY } from './plugin-rpc-setup.js'
import type { PluginDescriptor } from './plugin-types.js'

/** uiEvent 投递依赖（facade 状态的最小读取面） */
export interface UiEventDeliveryDeps { // oe-exempt:20261024:framework:ports/SDK 契约类型——接口先立、单实现常态（映射表/端口单一数据源）
  getDescriptor(pluginId: string): PluginDescriptor | undefined
  getWorkerHandle(pluginId: string): { workerId: string } | undefined
  notify(workerId: string, method: string, params: Record<string, unknown>): void
}

/**
 * 投递输入组件值回传给渲染该树的插件 Worker（D8）：插件不存在（已卸载 / 禁用后
 * renderer 迟到回传）或 Worker 不可用 → warn 丢弃。无投递对象时如实出声，不静默。
 */
export function deliverUiEventToPlugin(
  deps: UiEventDeliveryDeps,
  pluginId: string,
  viewId: string,
  componentId: string,
  event: string,
  value: unknown,
): void {
  if (!deps.getDescriptor(pluginId)) {
    console.warn(
      `[plugin-service] plugin.uiEvent dropped: plugin not found: ${pluginId} ` +
        '(uninstalled or disabled since the tree was rendered?)',
    )
    return
  }
  const handle = deps.getWorkerHandle(pluginId)
  if (!handle) {
    console.warn(`[plugin-service] plugin.uiEvent dropped: plugin worker not available: ${pluginId}`)
    return
  }
  deps.notify(handle.workerId, PLUGIN_UI_EVENT_NOTIFY, { viewId, componentId, event, value })
}

/**
 * plugin:event 广播 id 生成器（单调计数）：`${pluginId}_${Date.now()}` 在同一毫秒内
 * 多次状态上报会产出相同 id（与 viewUpdate push id 同款碰撞面）。
 */
export function createPluginEventIdGenerator(): () => string {
  let counter = 0
  return () => {
    counter += 1
    return `pe_${counter}`
  }
}

/**
 * 系统浏览器唤起（D9，plugin.ui.openUrl 的宿主出口）：平台打开命令 execFile 数组参数
 * （不经 shell，URL 已过 http(s) scheme 白名单——本出口不再做内容判定）。fire-and-forget：
 * 失败 warn 留痕（打开是尽力动作，插件侧有自己的重试入口）；env 经 buildOutboundChildEnv
 * （C-proc-09 出站契约）。
 *
 * Windows 用 rundll32 直传（不经 cmd）：`cmd /c start "" <url>` 会把 URL 交给 cmd 解析，
 * 插件可控 URL 里的 `&` / `|` / `^` 即命令注入面；execFile + rundll32 的参数不经 shell。
 */
export function openUrlInSystemBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open'
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url]
  execFile(
    command,
    args,
    { env: buildOutboundChildEnv({ parentEnv: process.env }), timeout: 10_000 },
    (err: Error | null) => {
      if (err) {
        console.warn(`[plugin-service] openExternal failed for ${url}:`, toErrorMessage(err))
      }
    },
  )
}
