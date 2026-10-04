export default {
  newTask: '新建任务',
  search: '搜索',
  developer: '开发者',
  settingsTitle: '设置',
  selectSessionHint: '选择会话查看文件',
  sessionListLoadFailed: '会话列表加载失败（{error}）',
  switchSessionFailed: '切换会话失败：{msg}',
  newTaskFailed: '新建任务失败：{msg}',
  deleteSessionFailed: '删除会话失败：{msg}',
  deleteFolderFailed: '删除文件夹会话失败：{msg}',
  // S3：带首个失败原因（error 占位符），让用户感知失败根因。zh-CN 无复数形态。
  deleteFolderPartialFailed: '{count} 个会话删除失败：{error}',
  renameFailed: '重命名失败：{msg}',
  retry: '重试',
  update: {
    newVersion: '新版本可用',
    newVersionWithVersion: '发现新版本 v{version}',
    versionTransition: '当前 v{from} → v{to}',
    downloading: '下载中 {percent}%',
    replacing: '替换中',
    restarting: '即将重启',
    error: '升级失败',
    goToDownload: '前往下载',
    downloaded: '已下载，重启安装',
    restartInstall: '重启并安装更新',
    confirmInstall: '新版本 v{version} 已下载完成。立即重启将中断当前所有任务（包括正在进行的 AI 会话），确定继续吗？',
    installLater: '稍后再说',
    installNow: '立即重启安装',
    retry: '重试',
    // 启动结果 toast（D5：升级成功/失败/回滚通知）
    upgradedToast: '已升级到 v{version}',
    upgradeFailed: '上次升级未完成',
    rolledBack: '上次升级未完成，已恢复到 v{version}',
    // A-D1：失败原因码细分文案（错误码→key 映射见 useAppUpdate LAUNCH_FAILURE_ERROR_KEYS）
    upgradeFailedReadOnly: '应用位于只读位置（如 DMG），请移入应用程序文件夹后重试',
    upgradeFailedBackup: '备份旧版本失败，请检查磁盘空间后重试',
    upgradeFailedExtract: '解压新版本失败，请检查磁盘空间后重试',
    upgradeFailedInternal: '升级过程内部错误，请重新检查更新并重试',
    upgradeFailedMove: '替换文件失败，请检查磁盘空间后重试',
    upgradeFailedSha: '新版本文件校验失败，请重新下载更新',
    upgradeFailedSwap: '替换应用失败，请检查磁盘空间后重试',
    upgradeFailedAppRunning: '升级因应用未退出而中断，请重启应用后重试',
    upgradeFailedInstaller: '安装程序执行失败，请重新下载更新',
    // RM2.3：限流退避中的非侵入提示（非错误，不进 error 态；多源后信号泛化为全源限流）
    rateLimited: '更新检查服务限流，约 2 小时内暂停自动检查',
    staleRelease: '检测到更新的版本，已为你刷新更新信息',
    // update-network-resilience D9：网络/代理类错误的 suggestion 末尾追加手动下载逃生通道指引
    manualDownloadHint: '也可从 release 页手动下载安装包，放入手动升级目录后重试（目录路径见 设置 → 更新 → 手动升级通道）',
  },
  sessionItem: {
    rename: '重命名',
    delete: '删除',
    deleteConfirm: '确认删除？',
    forkFrom: 'fork 自',
    markDone: '标记完成',
    unmarkDone: '取消标记',
    archived: '已归档',
    assignToProject: '归入项目',
    quoteToComposer: '引用到输入区',
    // agent-managed-session U8：agent 创建的 session 标记 badge（语言无关 token，两侧同文案）
    agentBadge: 'AI',
    viewParent: '查看父 session',
    // 强制退出（右键两段确认）：卡死 session 无停止按钮时的逃生入口
    forceQuit: '强制退出',
    forceQuitConfirm: '确认强制退出？',
    // 软停止（右键两段确认，ForkGroup 退役后迁入通用行）：运行中菜单项「停止」
    stop: '停止',
    stopConfirm: '确认停止？',
    // 子会话计数徒标（D9）：父条目右侧中性 chip 的 tooltip。数字口径 = 未完成子会话数
    // （非绿点：active / error / stopped / dead 都计入），故文案用「未完成」而非「运行中」。
    childCount: '{n} 个子会话未完成',
  },
  sessionList: {
    empty: '暂无会话',
    newSession: '新建会话',
    newSessionInFolder: '在此目录新建会话',
    deleteFolderConfirm: '确认删除此文件夹下所有会话？',
  },
  assignProjectFailed: '归入项目失败',
  forceQuitFailed: '强制退出失败：{msg}',
  // [session-dead 结构性修复 D3] 强制退出后 defer 队列回收进 Composer 草稿的显式提示
  forceQuitQueueRecovered: '{count} 条排队消息已收回草稿',
  // [session-dead 结构性修复 D6/D7 C1 方案一] 长 turn 观测面（Composer 上方常驻条）。
  // 文案纪律（D7）：只陈述事实，禁止判断词（卡死/无响应/异常/建议中止）；操作项中性不预置推荐
  segmentedTab: {
    session: '会话',
    file: '文件',
    plugin: '插件',
  },
  projectSwitcher: {
    defaultName: '默认项目',
    newProject: '新建项目',
    namePlaceholder: '项目名称',
    deleteProject: '删除项目',
    deleteTitle: '删除项目',
    deleteDesc: '确认删除项目「{name}」？该操作不可撤销。',
    deleteConfirm: '删除',
    cancel: '取消',
  },
  fileTree: {
    loading: '加载…',
    loadFailed: '加载失败（点击重试）',
    emptyDir: '（空目录）',
  },
  fileView: {
    hideIgnored: '隐藏忽略文件',
    showIgnored: '显示忽略文件',
    ignoredItem: '忽略项',
    filterPlaceholder: '过滤文件…',
    loadingTree: '加载文件树…',
    loadFailed: '加载失败（{reason}）',
    retry: '重试',
    noMatch: '无匹配文件',
    noFile: '暂无文件',
  },
  renameDialog: {
    title: '重命名会话',
    desc: '修改会话的显示名称',
    nameLabel: '名称',
    namePlaceholder: '输入会话名称',
    cancel: '取消',
    confirm: '确认',
    validationRequired: '请输入名称',
    validationMaxLength: '名称不能超过 {max} 个字符',
    validationPattern: '不允许换行符，最大 {max} 个字符',
  },
  // [HISTORICAL] 2026-09-16 侧栏任务 tab 退役：子代理列表 / 子代理筛选栏 / 工作流列表 /
  // 「后台命令」L2 视图四处死键全量删除——消费组件同批退役，任务文案现行承载 =
  // composer 任务托盘 `panel.tray.*`（locales/zh-CN/tray.ts）。
  // [C7 用词登记·迁移] 原「正在跑（任务域，占用中的子代理会话）vs 运行中（进程域，仅进程
  // running 的后台命令）」两套措辞刻意不统一——该域差异现行登记在两处：tray.ts 文件头
  // [词表裁决]（`panel.tray.bucket.running` 任务域 / `panel.tray.bucket.runningProcess`
  // 进程域）+ 本文件 turnProgress 节。概念域不同属真差异，勿合并措辞。
  workflowDetail: {
    terminate: '终止',
    terminateConfirm: '确认终止？',
    pendingHint: '等待执行中',
    agentsLabel: '{count} 个代理',
    turnsUnit: 'turns',
  },
}
