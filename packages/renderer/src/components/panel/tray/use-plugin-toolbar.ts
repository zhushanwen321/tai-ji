/**
 * usePluginToolbarContribution —— 插件 toolbar 挂载点（composer.toolbar）的贡献面判定。
 *
 * W3a 从 ComposerTray 抽出（该组件 `<script setup>` 已贴 300 行硬门禁）：聚合入口可见条件
 * 「托盘有条目 或 插件有贡献」与聚合面板承接段共用这一判定，唯一消费面在 ComposerTray。
 *
 * 数据源经 inject VIEW_HOST_SOURCE_KEY（未 provide 时恒 false，不崩不 warn——缺 source 只影响
 * 聚合入口/承接段判定）；有贡献 = `getView(sessionId, viewId)?.guiTree.length > 0`——挂载点把
 * N 个贡献合成一个 view，只有布尔面（与 use-composer-bar-density 的
 * pluginToolbarContributionCount 同口径）。
 */
import { computed, inject, toValue } from 'vue'
import type { ComputedRef, MaybeRefOrGetter } from 'vue'
import { VIEW_HOST_SOURCE_KEY } from '@taiji/ui/extension-host'

/** 插件 toolbar 挂载点名（= Composer 模板 `view-id` 字面量，与 use-composer-bar-density 同源） */
export const PLUGIN_TOOLBAR_VIEW_ID = 'composer.toolbar'

/**
 * @param sessionId 焦点 session id（响应式取值，切换 session 即重判）
 * @returns 是否有插件 toolbar 贡献
 */
export function usePluginToolbarContribution(
  sessionId: MaybeRefOrGetter<string>,
): ComputedRef<boolean> {
  const source = inject(VIEW_HOST_SOURCE_KEY, null)
  return computed(() => {
    if (!source) return false
    const view = source.getView(toValue(sessionId), PLUGIN_TOOLBAR_VIEW_ID)
    return view !== undefined && view.guiTree.length > 0
  })
}
