/**
 * session 文件名不变量原语：全仓约定「session 文件名（剥 .jsonl 后）最后一个 `_`
 * 之后的尾段 == header.id」——image-cache 孤儿判定/删除级联、session-reader 文件名
 * 提取、parent-session 兜底匹配、短名展示等消费点共享该不变量。
 *
 * 无 `_` 时返回剥后缀全串（对齐 session-reader extractSessionIdFromFilename 既有
 * 行为——uuid 直接作文件名无时间戳前缀的形态仍可提取）。uuid 特征校验是 reader 侧
 * 策略（非 uuid 特征按无 id 处理），不进基座：基座只承诺命名不变量本身。
 */

export function sessionIdFromFileName(fileName: string): string | undefined {
  const noExt = fileName.replace(/\.jsonl.*$/, '')
  const idx = noExt.lastIndexOf('_')
  const candidate = idx >= 0 ? noExt.slice(idx + 1) : noExt
  return candidate.length > 0 ? candidate : undefined
}
