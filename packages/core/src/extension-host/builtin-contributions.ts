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
 * - scheduler：
 *   slashCommands 声明（/schedule 单条，命令名与 pi.registerCommand 一致）
 *   ——landing 态无 session，pi 真源为空，slash 列表「声明即显示」（ADR-0050）；
 *   description 对齐 pi.registerCommand 注册期静态串（i18n.ts 中文词条）
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
  {
    // scheduler-manager（plugin-header-action-modal-points 首消费者，AP-1/AP-2）：
    // headerActions/modals 为新点位声明（icon 为 lucide 名宿主解析，插件不给 SVG；width 三档闭集）。
    // commands 是命令点击链的必要配套：commandId 须经 ensureCommandDeclarationsSync 注册进
    // CommandRegistry，点击才走 execute → WS plugin.executeCommand → Worker handler 闭环；
    // 缺声明则 E3「命令查不到」错误路径成为唯一路径（open 缺失 → G1 点击开层失效；
    // toggle/run/delete 缺失 → modal 内 action-bar 写操作 ERR6 死链）。id 与插件侧
    // api.commands.register 逐字一致（resources/plugins/scheduler-manager/index.ts）。
    pluginId: 'scheduler-manager',
    contributes: {
      headerActions: [
        { id: 'scheduler-manager.open', title: '定时任务', icon: 'clock', commandId: 'scheduler-manager.open', order: 20 },
      ],
      modals: [
        { id: 'scheduler-manager.panel', title: '定时任务', width: 'md' },
      ],
      commands: [
        { command: 'scheduler-manager.open', title: '定时任务' },
        { command: 'scheduler-manager.toggle', title: '暂停/恢复定时任务' },
        { command: 'scheduler-manager.run', title: '立即执行定时任务' },
        { command: 'scheduler-manager.delete', title: '删除定时任务' },
      ],
    },
  },
  {
    // scheduler 的 slashCommands 静态声明：landing 态无 session → pi 真源为空，slash 列表
    // 「声明即显示」（ADR-0050）——/schedule 命令路径创建本就是 landing 场景。description
    // 对齐 pi.registerCommand 注册期静态串（scheduler 包 i18n.ts 的 command.description
    // 中文词条）。命令名与 pi 侧注册一致（单条 /schedule）。执行仍由 pi extension
    // 承担（声明与执行分离）。
    pluginId: 'scheduler',
    contributes: {
      slashCommands: [
        { name: 'schedule', description: '新建定时任务（打开表单）' },
      ],
    },
  },
]
