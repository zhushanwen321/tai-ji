/**
 * ui locale zh-CN 单侧聚合：只含被 ui 展示组件直接消费 key 的域文件。
 *
 * 域文件级下沉规则：凡 ui 组件（features/chat、features/settings、features/new-task、
 * extension-host、overlays）消费任何 key 的域文件整体迁入本模块（无 key 级拆分——
 * 同一域文件内双源漂移面大于整域迁移）；纯 renderer 壳消费的域文件留守 renderer 壳。
 * 当前聚合的迁移域（grep ui src 的 t() key 前缀 ∩ renderer 域文件交集实测）：
 * common / settings / panel / newTask / extensionUI / search / composable。
 *
 * 注意：本聚合不含 tray 子树（tray.ts 是桌面壳任务托盘文案，运行时并入 panel
 * 命名空间但无 ui 组件消费，留守 renderer 壳）。桌面 renderer 聚合自行完成
 * panel + tray 的展开合并，key 空间与迁移前逐字节等价。
 */
import common from './zh-CN/common'
import settings from './zh-CN/settings'
import panel from './zh-CN/panel'
import newTask from './zh-CN/newTask'
import extensionUI from './zh-CN/extensionUI'
import search from './zh-CN/search'
import composable from './zh-CN/composable'

export default {
  common,
  settings,
  panel,
  newTask,
  extensionUI,
  search,
  composable,
}
