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
import canvas from './en-US/canvas'
import find from './en-US/find'
import subagent from './en-US/subagent'
import archive from './en-US/archive'

export default {
  common,
  connection,
  app,
  settings,
  sidebar,
  archive,
  // tray.ts 只含 tray 子树，展开并入 panel 命名空间（运行时 key = panel.tray.*；
  // 顶层键唯一性约束下不能并列两个 panel 键）。panel 本体文案经 ui locale 域文件
  // 下沉迁移自 @taiji/ui/locale，tray 子树留守本壳（无 ui 组件消费）。workflow-viz.ts
  // 同款并入（运行时 key = panel.workflowViz.*）；canvas.ts 同款并入
  // （运行时 key = panel.canvas.*——problem-solve-canvas U7 组件文案）；subagent.ts 同款
  // 并入（运行时 key = panel.sideDrawer.*——SubagentTab 组件自有文案，无 ui 组件消费故留守本壳）
  // sideDrawer 显式浅合并（浅展开会整棵覆盖 ui panel 的 sideDrawer 子树，抹掉既有 key）
  panel: {
    ...panel,
    ...tray,
    ...workflowViz,
    ...canvas,
    sideDrawer: { ...panel.sideDrawer, ...subagent.sideDrawer },
  },
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
  find,
}
