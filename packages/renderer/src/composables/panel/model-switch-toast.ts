/**
 * 模型/档位切换失败 → toast 文案 key 的**单点映射**（model-switch-live-provider-sync U4）。
 *
 * 为什么单点：两条触发路径都要给用户提示——① UI 路径（点 composer 的模型/档位 chip 与
 * popover，经壳层包装）；② 键盘循环路径（ctrl+p / shift+tab，经 shortcut 的内联 catch）。
 * 两条路径若各写一份 code→key 映射，迟早漂移（同一个失败在两处显示不同文案）。
 *
 * 映射表 = 设计 §3.4 错误规格表：5 个新码各有专用文案；**4 个既有透传码**
 * （SESSION_NOT_FOUND / MODEL_NOT_CONFIGURED / RESTORE_FAILED / BUILTIN_EXTENSIONS_MISSING）
 * 与一切未知码落 `general`（toast 文本附后端 message，用户仍能读到原始信息）。
 */

/** 运行时错误对象的最小读取面（不引入 `any`：code 可为字符串语义码或数值 JSON-RPC 码）。 */
interface ErrorWithCode {
  code?: unknown
  message?: unknown
}

const CODE_TO_KEY: Record<string, string> = {
  SESSION_ACTIVATE_FAILED: 'panel.panel.modelSwitch.sessionActivateFailed',
  SESSION_ACTIVATE_TIMEOUT: 'panel.panel.modelSwitch.sessionActivateTimeout',
  MODEL_NOT_FOUND: 'panel.panel.modelSwitch.modelNotFound',
  PROVIDER_CREDENTIAL_MISSING: 'panel.panel.modelSwitch.providerCredentialMissing',
  ENGINE_MODEL_MISSING: 'panel.panel.modelSwitch.engineModelMissing',
}

/**
 * 返回 i18n key（不含翻译）；`general` 兜底。
 *
 * 输入宽松（unknown）：调用方拿到的可能是 Error、字符串、RPC 错误包——取 `code` 与 `message`
 * 时全部做类型守卫，绝不当 `any` 用。
 */
export function modelSwitchToastKey(err: unknown): string {
  const code = typeof err === 'object' && err !== null ? (err as ErrorWithCode).code : undefined
  if (typeof code === 'string' && code in CODE_TO_KEY) return CODE_TO_KEY[code]
  return 'panel.panel.modelSwitch.general'
}

/** 提取可读 message（toast 的 `{error}` 插值源）；无 message 时退化为空串。 */
export function modelSwitchErrorMessage(err: unknown): string {
  if (typeof err === 'string') return err
  if (typeof err === 'object' && err !== null) {
    const message = (err as ErrorWithCode).message
    if (typeof message === 'string') return message
  }
  return ''
}
