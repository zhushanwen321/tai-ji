// src/error-message.ts
//
// 「错误 → 可读字符串」兜底单源（round1-reuse R11 微副本收编：core
// src/core/error-message.ts、pi/zcode 引擎包 error-message.ts 副本自本模块
// re-export 收编；此前各包自持先例见各自 shim 注释）。
//
// [A8 修复]（round1 business-logic S1 登记，可操作性修复）：非 Error 的 object
// 入参改 JSON.stringify 结构化文本（协议错误帧 {code,message,recovery} 直进文案，
// 不再退化为 "[object Object]"）；stringify 抛错（循环引用等）兜底 String(e)。
// Error 入参输出逐字节不变。

export function toErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e !== null) {
    try {
      return JSON.stringify(e);
    } catch {
      return String(e);
    }
  }
  return String(e);
}
