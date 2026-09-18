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
 *
 * 曾声明的 base-tool-enhance「后台命令」sidebar.tab view 已随该 native 视图退役
 * （composer-task-tray D10：托盘承接后台命令观察面，Plugins tab 的 plugin sidebar
 * view 机制本身保留——现由 external plugin 贡献面提供）。
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
    // todo/goal 状态经 extension widget 推送（guiSetWidget）由 Composer 托盘 widget 区承接，不进 sidebar。
    pluginId: 'tasks',
    contributes: {
      slashCommands: [
        { name: 'goal', description: '创建目标' },
        { name: 'todo', description: '创建任务' },
      ],
    },
  },
]
