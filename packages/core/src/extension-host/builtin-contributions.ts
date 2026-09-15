/**
 * builtin-contributions.ts —— builtin 双插件静态 manifest（DM5）。
 *
 * builtin plugin 的 contributes 静态声明（不经 runtime，feature D1「builtin 免审批先行」）。
 * 形状按 core 版 PluginContributes v2（types.ts，对齐 s1 schema v2）。
 *
 * - statusline（与 runtime 侧 statusline plugin 同名对齐）：
 *   statusBarItems 文本为空串——实际内容由 runtime plugin:statusBarUpdate 广播填充
 * - tasks（goal/todo，s5 落地 plugin 实体）：
 *   slashCommands 声明（goal/todo，name 不含前导 /，对齐 s1 schema v2 形状），执行仍由 pi extension 承担（§8 边界）
 * - base-tool-enhance（后台命令视图，background-task-sidebar-view D4①）：
 *   第一个真实 sidebar.tab view 贡献——「后台命令」L2 视图（术语裁决见设计 §1：「后台任务」
 *   已被 subagent i18n 占用）。渲染载体是原生组件（renderer BackgroundTaskListView，经
 *   PluginViewContainer NATIVE_VIEWS 路由），viewType 沿用 'gui' 不改 schema（D4②）；
 *   title 是静态贡献声明的数据链路（非 i18n key，与上方 tasks 中文 description 同范式），
 *   组件内运行时文案仍走 i18n。pluginId 不可关闭（PluginViewContainer BUILTIN_PLUGIN_IDS）。
 *
 * 本文件是 ContributionRegistry 的扁平贡献源，也是消费侧唯一真相（曾并存的插件
 * 实体级 manifest builtin/tasks/manifest.ts 已随 D11 死面清理删除——形状漂移且生产零消费）。
 */
import type { BuiltinContribution } from './types'

export const builtinContributions: BuiltinContribution[] = [
  {
    pluginId: 'statusline',
    contributes: {
      statusBarItems: [
        { id: 'statusline', text: '', priority: 0 },
      ],
    },
  },
  {
    // tasks 的 slashCommands 仍静态声明（W3 CommandRegistry 收编需要）；其 views 不声明——
    // todo/goal 状态经 extension widget 推送（guiSetWidget）由 M17 对话流面板承接，不进 sidebar。
    pluginId: 'tasks',
    contributes: {
      slashCommands: [
        { name: 'goal', description: '创建目标' },
        { name: 'todo', description: '创建任务' },
      ],
    },
  },
  {
    // 后台命令 L2 视图（background-task-sidebar-view.md D4①/D9）：数据链路 = runtime 直读
    // registry + WS backgroundTask.* 域；渲染 = renderer 原生 BackgroundTaskListView。
    // id 与实体命名一致（viewId 'background-tasks'），title 用「后台命令」（§1 术语裁决）。
    pluginId: 'base-tool-enhance',
    contributes: {
      views: [
        {
          id: 'background-tasks',
          title: '后台命令',
          placement: 'sidebar.tab',
          viewType: 'gui',
        },
      ],
    },
  },
]
