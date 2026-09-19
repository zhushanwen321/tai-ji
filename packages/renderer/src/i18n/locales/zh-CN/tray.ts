/**
 * Composer 任务托盘（tray）—— built-in 四件面板文案
 * （bash / subagent / workflow / session；设计 docs/design/composer-task-tray.md §3.3 D2/D9 + §3.5 错误规格）。
 *
 * 命名空间形态：本模块 default export 只含 tray 子树，由 aggregator（locales/zh-CN.ts）
 * 展开并入 panel 命名空间（`panel: { ...panel, ...tray }`）——运行时 key 前缀 =
 * `panel.tray.*`（顶层键唯一性约束下不能并列两个 panel 键）。en-US/tray.ts 必须键集合
 * 完全一致（守卫 = .githooks/check_i18n_locale_sync.py + __tests__/i18n/locale-sync-check.test.ts）。
 *
 * [词表裁决] 三件共用一套桶标签，仅 bash 例外：进程域（bash）用「运行中」，任务域
 * （subagent / workflow）用「进行中」——沿用 sidebar.ts 已登记的域差异（任务域 = 占用中的
 * 子代理会话；进程域 = 仅进程 running 状态），托盘不合并两类措辞，也不把两套术语混进同一标签。
 *
 * 空态文案用 {name} 插值（调用方传 title.<kind>）：各桶措辞对称，避免逐 kind 复制多份。
 */
export default {
  tray: {
    /** 托盘 icon 行的 aria-label（整行为一个语义组；各 icon 另有 title.<kind>） */
    trayLabel: '任务托盘',
    /** 四件标题（面板 aria-label；外壳 icon 的 title/aria 复用） */
    title: {
      bash: '后台命令',
      subagent: '子代理',
      workflow: '工作流',
      session: '子会话',
    },
    /** 分桶视图标签（runningProcess 仅 bash 使用，见文件头词表裁决；[两视图裁决 2026-09-16] subagent 无第三桶） */
    bucket: {
      running: '进行中',
      runningProcess: '运行中',
      ended: '已结束',
    },
    loading: '加载中…',
    loadFailed: '加载失败（{error}）',
    retry: '重试',
    /** 当前桶为空时的提示（{name} = 四件标题） */
    empty: {
      running: '没有进行中的{name}',
      runningProcess: '没有运行中的{name}',
      ended: '暂无已结束的{name}',
    },
    /** 空态可行动按钮（D9：显式切桶，不自动跳转） */
    viewEnded: '查看已结束 ({count})',
    /** 行内操作（后台命令） */
    kill: '终止',
    killConfirm: '确认终止',
    killFailed: '终止后台命令失败：{msg}',
    /** 行内操作（子代理） */
    cancel: '取消',
    cancelConfirm: '确认取消？',
    alreadyEnded: '任务已结束',
    cancelFailed: '取消子代理失败：{msg}',
    /** 行内操作（工作流） */
    abort: '终止',
    abortConfirm: '确认终止？',
    workflowOpFailed: '工作流操作失败：{msg}',
    /** 行摘要单位与标签 */
    agentsLabel: '{done}/{total}',
    turnsUnit: 'turns',
    tokUnit: 'tok',
    pidLabel: 'pid',
    exitLabel: 'exit',
    /** 后台命令状态文字后备（aria-label / icon title；判定本身在 background-task-bucket SSOT） */
    status: {
      running: '运行中',
      killing: '终止中',
      orphaned: '孤儿任务',
      killed: '已终止',
      succeeded: '已成功',
      failed: '已失败',
    },
    /** 面板顶部提示条（bash） */
    corruptBanner: '任务数据损坏，已忽略（.corrupt 保留现场）',
    disconnectBanner: '连接断开，重连后自动刷新',
    /** 序 3 溢出入口（`»` 省略号；与聚合入口的层叠图标是两个语义，见 Composer.vue 底栏注释） */
    more: '更多工具',
    /** 序 4 聚合入口（层叠图标 + 运行数）：title / aria-label 带运行数插值 */
    aggregate: {
      title: '任务托盘 · {running} 项进行中',
    },
    /**
     * 第 4 件「子会话」（u7，设计 .tmp/tech-design/mode-system-composer-density.md §6.7 D7）。
     * 行状态文案与 TraySessionPanel 的进程级 status 映射一一对应（映射本体见
     * composables/logic/sessionStatus.ts 的 DISPLAY_STATUS）。
     */
    session: {
      /** 段头摘要（{total} 个 · {running} 运行中） */
      header: '{total} 个 · {running} 运行中',
      empty: '暂无子会话',
      status: {
        running: '运行中',
        done: '已完成',
        error: '失败',
        stopped: '已停止',
      },
      stop: '停止',
      stopConfirm: '确认停止',
      stopFailed: '停止子会话失败：{msg}',
      openFailed: '打开子会话失败：{msg}',
    },
  },
}
