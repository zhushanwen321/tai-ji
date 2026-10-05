import common from '@taiji/ui/locale/en-US/common'
import connection from './en-US/connection'
import app from './en-US/app'
import settings from '@taiji/ui/locale/en-US/settings'
import sidebar from './en-US/sidebar'
import panel from '@taiji/ui/locale/en-US/panel'
import tray from './en-US/tray'
import workspace from './en-US/workspace'
import newTask from '@taiji/ui/locale/en-US/newTask'
import shell from './en-US/shell'
import extensionUI from '@taiji/ui/locale/en-US/extensionUI'
import search from '@taiji/ui/locale/en-US/search'
import composable from '@taiji/ui/locale/en-US/composable'
import importSession from './en-US/importSession'
import rollingRestart from './en-US/rollingRestart'
import plan from './en-US/plan'
import btw from './en-US/btw'
import workflowViz from './en-US/workflow-viz'

export default {
  common,
  connection,
  app,
  settings,
  sidebar,
  // tray.ts 只含 tray 子树，展开并入 panel 命名空间（运行时 key = panel.tray.*；
  // tray.ts 只含 tray 子树，展开并入 panel 命名空间（运行时 key = panel.tray.*；
  // 顶层键唯一性约束下不能并列两个 panel 键）。panel 本体文案经 ui locale 域文件
  // 下沉迁移自 @taiji/ui/locale，tray 子树留守本壳（无 ui 组件消费）。workflow-viz.ts
  // 同款并入（运行时 key = panel.workflowViz.*——workflow-visualization U4 组件文案）
  panel: { ...panel, ...tray, ...workflowViz },
  workspace,
  newTask,
  shell,
  extensionUI,
  search,
  composable,
  importSession,
  rollingRestart,
  plan,
  btw,
}
