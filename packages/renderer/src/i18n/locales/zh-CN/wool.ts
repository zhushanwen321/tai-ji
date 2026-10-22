/**
 * 羊毛 provider（wool-provider D6 ①③/D7）i18n：向导（类型选择 → 家族卡 → 两族模板步骤）+
 * provider 列表羊毛条目（额度/模型数/签到/失效徽标）+ 失败路径表恢复指引文案。
 * 双侧 key 对齐检查 = locale-sync-check（zh-CN/wool.ts ↔ en-US/wool.ts 逐键对称）。
 */
export default {
  // 入口（ProviderTemplatePicker 菜单项 + 向导类型说明）
  menuLabel: '羊毛 provider',
  menuBeta: 'Beta',
  entryDesc: '把已登录 AI IDE 的内置模型额度接入为本地 Provider，无需 API Key',
  // 家族选择页（三张卡 + 固定风险行）
  familyTitle: '选择家族',
  familyRiskNotice: '非官方接口：使用你自己的账号额度，存在账号风控与接口变动风险；凭据与协议实装仅在本机运行',
  detectOk: '检测到登录态',
  detectNone: '未检测到登录态',
  detectChecking: '检测中…',
  oauthRequired: '需授权',
  startAdopt: '开始接入',
  // 向导通用步骤文案（两族共用的 install/done）
  stepInstall: '安装扩展',
  stepInstallRunning: '正在安装…',
  stepDone: '完成',
  retry: '重试',
  cancel: '取消',
  close: '关闭',
  finish: '完成',
  // 提取族（ide-extract：安装 → 凭据 → 完成）
  stepCredentials: '凭据提取',
  extractConfirmTitle: '确认提取凭据',
  extractConfirmBody: '将从本机 {family} 的登录数据中读取凭据（只读取必需字段），存入本机 pi 模型配置（models.json），仅在本机使用、不外发。',
  extractConfirmOk: '提取',
  extractRunning: '正在提取…',
  // 授权族（oauth：安装 → 授权 → 就绪 → 签到 → 完成）
  stepAuthorize: '账号授权',
  authorizeOpen: '在 TaiJi 浏览器中打开授权页',
  authorizePending: '等待授权完成…',
  authorizeOpenedHint: '授权页已在浮层浏览器打开，请完成登录授权；完成后点「我已完成授权」',
  authorizeDone: '我已完成授权',
  authorizeCancel: '取消授权',
  authorizeRetryHint: '浏览器内尚未完成登录，请完成后再点「我已完成授权」',
  stepReady: '凭据就绪',
  stepCheckin: '签到与续期',
  autoCheckinLabel: '每日自动签到',
  autoCheckinOffHint: '到点提醒你手动签到',
  autoCheckinWarn: '自动任务与官方客户端行为差异大，社区有批量封号案例',
  renewLabel: '令牌自动续期',
  renewHint: '令牌到期前自动续期（凭据随重新授权/提取更新）',
  // 完成步（模型清单加载态）
  catalogLoading: '正在加载模型清单…',
  catalogCount: '{count} 个模型已就绪',
  // provider 列表羊毛条目
  listTitle: '羊毛 Provider',
  badgeWool: '羊毛',
  badgeModelsCount: '{count} 模型',
  badgeCheckinDone: '今日已签到',
  badgeCheckinTodo: '今日未签到',
  quotaUsed: '额度 {used}/{total} {unit}',
  quotaOnly: '已用 {used} {unit}',
  loginExpired: '登录态失效',
  notAdoptedHint: '未完成接入',
  catalogFetchedAt: '数据时点 {time}',
  refresh: '刷新',
  // 失效重授权（401 分类命中后的恢复入口：oauth 重跑 authorize / 提取族重跑 extract）
  reauthorize: '重新授权',
  reextract: '重新提取',
  reauthHint: '登录态已失效，重新执行授权/提取以恢复接入',
  // 更新角标（D2 更新提示经条目角标，用户显式触发更新）
  badgeUpdate: '可更新',
  updateHint: '当前 {version}，清单有新版本；点击更新（新会话生效）',
  // 卸载（D3 编排：扩展侧 clear 进程内副本与模型目录 + 删除 models.json 凭据条目 +
  // 卸载扩展 + 移除接入状态；凭据条目删除被拒时按残留提示修复）
  uninstall: '卸载',
  uninstallConfirmTitle: '卸载 {name} 羊毛 provider？',
  uninstallConfirmDesc: '将卸载扩展包、删除本机凭据条目（models.json）、清理模型目录缓存与接入状态。需要重新使用须重跑接入向导。',
  uninstallConfirmBtn: '卸载',
  uninstallResidualFallback: '扩展已卸载，但本机凭据条目删除未完成：请按提示修复 models.json 后重试卸载。',
  // 失败路径表（WoolActionErrorCode / WoolStepFailureCode → 恢复指引）
  errManifestUnreachable: '无法获取版本清单，请检查网络后重试（清单不可达时不安装）',
  errManifestBadShape: '版本清单格式损坏，请稍后重试或检查发布通道',
  errFamilyAbsent: '清单中没有该家族条目，请升级 taiji 或等待清单更新',
  errInstallFailed: '扩展安装失败：{message}',
  errExtensionMissing: '扩展未加载，请重试或重装后重试',
  errNotLoggedIn: '暂无有效登录态，请重新执行接入流程',
  errUpstreamError: '上游调用失败：{message}',
  errAuthorizeUnavailable: '授权动作通道未就绪（扩展版本可能过旧，协议暂不支持），请更新羊毛扩展后重试',
  errExtractUnavailable: '凭据提取动作通道未就绪（扩展版本可能过旧，协议暂不支持），请更新羊毛扩展后重试',
  errActionNotSupported: '该家族不支持此接入动作（凭据来源策略不符），请使用对应的接入方式',
  errUninstallFailed: '扩展卸载失败：{message}',
  errInternal: '内部异常：{message}',
  errManageUnavailable: '管理通道不可用：{message}',
  errCancelled: '已取消',
}
