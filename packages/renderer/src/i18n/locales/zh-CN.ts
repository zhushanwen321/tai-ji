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
import plan from './zh-CN/plan'
import btw from './zh-CN/btw'
import wool from './zh-CN/wool'
import workflowViz from './zh-CN/workflow-viz'
import canvas from './zh-CN/canvas'
import find from './zh-CN/find'
import subagent from './zh-CN/subagent'
import archive from './zh-CN/archive'

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
  // 同款并入（运行时 key = panel.workflowViz.*——workflow-visualization U4 组件文案）；
  // canvas.ts 同款并入（运行时 key = panel.canvas.*——problem-solve-canvas U7 组件文案）；
  // subagent.ts 同款并入（运行时 key = panel.sideDrawer.*——SubagentTab 组件自有文案，
  // 无 ui 组件消费故留守本壳）；sideDrawer 显式浅合并（浅展开会整棵覆盖 ui panel 的
  // sideDrawer 子树，抹掉 workflowPending 等既有 key）
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
  wool,
  find,
}
