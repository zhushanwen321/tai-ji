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
  extractConfirmBody: '将从本机 {family} 的登录数据中读取凭据（只读取必需字段），存入 pi 凭据库，仅在本机使用、不外发。',
  extractConfirmOk: '提取',
  extractRunning: '正在提取…',
  // 授权族（oauth：安装 → 授权 → 就绪 → 签到 → 完成）
  stepAuthorize: '账号授权',
  authorizeOpen: '在 TaiJi 浏览器中打开授权页',
  authorizePending: '等待授权完成…',
  stepReady: '凭据就绪',
  stepCheckin: '签到与续期',
  autoCheckinLabel: '每日自动签到',
  autoCheckinOffHint: '到点提醒你手动签到',
  autoCheckinWarn: '自动任务与官方客户端行为差异大，社区有批量封号案例',
  renewLabel: '令牌自动续期',
  renewHint: '令牌到期前自动续期（pi 凭据机制承载）',
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
  // 失败路径表（WoolActionErrorCode / WoolStepFailureCode → 恢复指引）
  errManifestUnreachable: '无法获取版本清单，请检查网络后重试（清单不可达时不安装）',
  errManifestBadShape: '版本清单格式损坏，请稍后重试或检查发布通道',
  errFamilyAbsent: '清单中没有该家族条目，请升级 taiji 或等待清单更新',
  errInstallFailed: '扩展安装失败：{message}',
  errExtensionMissing: '扩展未加载，请重试或重装后重试',
  errNotLoggedIn: '暂无有效登录态，请重新执行接入流程',
  errUpstreamError: '上游调用失败：{message}',
  errAuthorizeUnavailable: '授权动作通道未就绪（扩展管理协议暂不支持），请等待羊毛扩展更新后重试',
  errExtractUnavailable: '凭据提取动作通道未就绪（扩展管理协议暂不支持），请等待羊毛扩展更新后重试',
  errInternal: '内部异常：{message}',
  errManageUnavailable: '管理通道不可用：{message}',
  errCancelled: '已取消',
}
