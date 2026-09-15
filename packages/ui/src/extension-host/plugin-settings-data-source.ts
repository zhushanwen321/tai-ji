/**
 * PluginSettingsPage 数据源接口（W4 · T1）。
 *
 * 组件只消费此接口（inject），不直接依赖 S2 contribution-registry 内部实现：
 *  - onPlugins：插件列表订阅（真实实现接 runtime config.plugins / plugin.list 通道）
 *  - getContributions：插件 contributions 可用性查询（真实实现接 S2 contribution-registry，
 *    available=false = 声明了但当前平台不可用，如未注册挂载点的 placement）
 *
 * 真实实现由壳（P5）provide；单测 mock 注入。S2 未落地不阻塞本组件交付（接口契约先行）。
 */
import type { PluginInfo } from '@taiji/shared'
import type { InjectionKey } from 'vue'

/** 单条 contribution 的展示形状（id/type 来自插件声明，available 来自 S2 registry 判定） */
export interface ContributionInfo {
  id: string
  type: string
  available: boolean
  /** 不可用原因；为空时组件展示默认文案「当前平台不支持该挂载点」 */
  reason?: string
}

export interface PluginSettingsDataSource {
  /** 订阅插件列表，返回退订函数 */
  onPlugins(handler: (plugins: PluginInfo[]) => void): () => void
  /** 查询某插件的 contributions 可用性 */
  getContributions(pluginId: string): ContributionInfo[]
}

export const PluginSettingsDataSourceKey: InjectionKey<PluginSettingsDataSource> =
  Symbol('plugin-settings-data-source')
