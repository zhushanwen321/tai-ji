import common from './en-US/common'
import connection from './en-US/connection'
import app from './en-US/app'
import settings from './en-US/settings'
import sidebar from './en-US/sidebar'
import panel from './en-US/panel'
import tray from './en-US/tray'
import workspace from './en-US/workspace'
import newTask from './en-US/newTask'
import shell from './en-US/shell'
import extensionUI from './en-US/extensionUI'
import search from './en-US/search'
import composable from './en-US/composable'
import importSession from './en-US/importSession'
import rollingRestart from './en-US/rollingRestart'
import plan from './en-US/plan'

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
