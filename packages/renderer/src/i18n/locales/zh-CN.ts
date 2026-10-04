import common from '@taiji/ui/locale/zh-CN/common'
import connection from './zh-CN/connection'
import app from './zh-CN/app'
import settings from '@taiji/ui/locale/zh-CN/settings'
import sidebar from './zh-CN/sidebar'
import panel from '@taiji/ui/locale/zh-CN/panel'
import tray from './zh-CN/tray'
import workspace from './zh-CN/workspace'
import newTask from '@taiji/ui/locale/zh-CN/newTask'
import shell from './zh-CN/shell'
import extensionUI from '@taiji/ui/locale/zh-CN/extensionUI'
import search from '@taiji/ui/locale/zh-CN/search'
import composable from '@taiji/ui/locale/zh-CN/composable'
import importSession from './zh-CN/importSession'
import rollingRestart from './zh-CN/rollingRestart'

export default {
  common,
  connection,
  app,
  settings,
  sidebar,
  // tray.ts 只含 tray 子树，展开并入 panel 命名空间（运行时 key = panel.tray.*；
  // 顶层键唯一性约束下不能并列两个 panel 键）。panel 本体文案经 ui locale 域文件
  // 下沉迁移自 @taiji/ui/locale，tray 子树留守本壳（无 ui 组件消费）。
  panel: { ...panel, ...tray },
  workspace,
  newTask,
  shell,
  extensionUI,
  search,
  composable,
  importSession,
  rollingRestart,
}
