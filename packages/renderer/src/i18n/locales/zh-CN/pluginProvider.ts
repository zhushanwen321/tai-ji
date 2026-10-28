/**
 * 插件 Provider 来源（provider-plugin-access U6/D1/D2/D5/D8）i18n：接入流程（家族选择 →
 * 安装确认 → 授权挂载位）、条目扩展区与状态行、条目级动作。
 *
 * 界面内容主体由插件用 GuiComponent 树提供（插件文案自带，不进宿主 i18n）；本域只覆盖
 * 宿主提供的壳与统一字段。双侧 key 对齐（zh-CN ↔ en-US 逐键对称）。
 */
export default {
  // 流程壳
  flow: {
    title: '添加插件 Provider',
    subtitle: '插件提供家族元数据、授权流程与模型目录；宿主只负责凭据落盘与条目管理',
    authorizeTitle: '授权 {name}',
    authorizeSubtitle: '授权流程由插件渲染',
    installTitle: '安装插件',
    installSubtitle: '确认下方知情面后再安装',
    updateTitle: '更新插件',
    installedBadge: '已安装',
    updateBadge: '可更新',
    installHint: '需要先安装插件',
    credentialOauth: '需在浏览器授权',
    credentialExtract: '读取本机登录态',
    modelCount: '{count} 个可用模型',
    emptyCatalog: '清单为空：没有可安装的 Provider 插件',
    catalogLoading: '正在加载插件清单…',
    // S15 两态（R-2 wire 字段）：stale = 缓存兜底提示；unavailable = 无缓存且拉取失败（报错态）
    staleHint: '清单可能不是最新（上次拉取未确认新鲜）',
    catalogUnavailable: '插件清单不可达：无本地缓存且拉取失败，请检查网络后重试',
    retry: '重试',
    focusMissing: '目标插件不在清单中（可能已被移除），请重新打开页面',
    channelUnavailable: '安装通道未就绪：请更新到支持插件安装的版本后重试',
    confirmFailed: '安装失败',
    // S13 崩溃恢复（失败路径表：crashed 家族卡「插件已停止」+ 重启 = toggle off/on）
    stoppedBadge: '插件已停止',
    restart: '重启',
    restarting: '重启中…',
    restartFailed: '重启失败：{reason}',
    // 安装确认卡（S27 知情面）
    confirmInstallDesc: '将安装插件',
    confirmUpdateDesc: '将更新插件',
    capabilitiesLabel: '能力声明（capabilities）',
    readPathsLabel: '可读取路径（readPaths）',
    permissionsLabel: '权限（permissions）',
    noneDeclared: '未声明',
    confirmHint: '安装即授予上述声明的能力；未确认不会安装落盘。',
    confirmInstall: '安装',
    confirmUpdate: '更新',
    cancel: '取消',
    // 包名直装（S27 第二路径）
    directInstallPlaceholder: "或直接输入插件包名（如 {'@'}scope/plugin-xxx）",
    directInstallBtn: '安装此包',
  },
  // 条目扩展区
  detailExtra: {
    title: '插件内容',
  },
  // 条目级动作
  actions: {
    reauthorize: '重新授权',
    updatePlugin: '更新插件',
  },
  // 条目行标记
  row: {
    pluginBadge: '插件',
  },
  // 凭据状态（插件上报的展示映射；未上报 = 零标记，D5/S5）
  status: {
    fallbackValid: '凭据可用',
    fallbackInvalid: '凭据可能已失效',
  },
}
