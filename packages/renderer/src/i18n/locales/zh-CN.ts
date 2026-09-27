import common from './zh-CN/common'
import connection from './zh-CN/connection'
import app from './zh-CN/app'
import settings from './zh-CN/settings'
import sidebar from './zh-CN/sidebar'
import panel from './zh-CN/panel'
import tray from './zh-CN/tray'
import workspace from './zh-CN/workspace'
import newTask from './zh-CN/newTask'
import shell from './zh-CN/shell'
import extensionUI from './zh-CN/extensionUI'
import search from './zh-CN/search'
import composable from './zh-CN/composable'
import importSession from './zh-CN/importSession'
import rollingRestart from './zh-CN/rollingRestart'
import plan from './zh-CN/plan'

export default {
  common,
  connection,
  app,
  settings,
  sidebar,
  // tray.ts 只含 tray 子树，展开并入 panel 命名空间（运行时 key = panel.tray.*；
  // 顶层键唯一性约束下不能并列两个 panel 键）
  panel: { ...panel, ...tray },
  workspace,
  newTask,
  shell,
  extensionUI,
  search,
  composable,
  importSession,
  rollingRestart,
  plan,
}
