/**
 * parentSession 溯源解析（design §3.4 SESSION 行 + §3.1 样例 5）。
 *
 * fork 出的 session 文件 header 的 parentSession 有两种形态（pi session-lifecycle
 * fallback 语义：源 session 已落盘时为 JSONL 文件绝对路径、未落盘时为 sessionId 字符串），
 * 溯源跳转两种都要解。解析是纯数据交叉匹配（无 IO）：把 ref 与 sidebar session 列表
 * （id + sessionFile）对上，返回目标 session 候选。
 */
export interface TraceParentSessionCandidate {
  id: string
  /** session JSONL 绝对路径（pi 延迟写入窗口内可能缺省）。 */
  sessionFile?: string
}

/**
 * ref 是否为文件路径形态（含路径分隔符或以 .jsonl 结尾）。
 * sessionId 形态（uuid / 短 id）不含分隔符，不会误判。
 */
export function isTraceParentSessionPath(ref: string): boolean {
  return ref.includes('/') || ref.includes('\\') || ref.endsWith('.jsonl')
}

/**
 * 从 session JSONL 文件路径提取 sessionId。
 *
 * pi session 文件名格式 `<ISO>_<sessionId>.jsonl`（ISO 时间戳不含下划线，lastIndexOf('_')
 * 分割取尾段）；无 `<ts>_` 前缀的裸 `<sessionId>.jsonl` 也兼容（整段即 id）。提取失败
 * （空 basename）返回 null。
 */
export function extractSessionIdFromTraceFilePath(path: string): string | null {
  const base = path.replace(/\\/g, '/').split('/').pop() ?? ''
  const noExt = base.endsWith('.jsonl') ? base.slice(0, -'.jsonl'.length) : base
  if (!noExt) return null
  const idx = noExt.lastIndexOf('_')
  const sid = idx >= 0 ? noExt.slice(idx + 1) : noExt
  return sid !== '' ? sid : null
}

/**
 * 解析 parentSession ref 到 sidebar 列表中的目标 session。
 *
 * 三段匹配（逐段兜底）：
 *  1. ref 与 sessionFile 精确相等（路径形态主路径——同一 runtime 产出的路径形态一致）
 *  2. ref 与 id 精确相等（sessionId fallback 形态主路径）
 *  3. ref 为路径形态时从 basename 提取 `<ts>_<sessionId>.jsonl` 的 sessionId 段再按 id
 *     匹配（sessionFile 因扫描 TTL / 未回填与 ref 漂移时的兜底）
 *
 * 全部未命中返回 null（调用方显示「源 session 未找到」——目标可能已被删除）。
 */
export function resolveTraceParentSession(
  ref: string,
  sessions: readonly TraceParentSessionCandidate[],
): TraceParentSessionCandidate | null {
  const byFile = sessions.find((s) => s.sessionFile === ref)
  if (byFile) return byFile
  const byId = sessions.find((s) => s.id === ref)
  if (byId) return byId
  if (isTraceParentSessionPath(ref)) {
    const sid = extractSessionIdFromTraceFilePath(ref)
    if (sid !== null) {
      const byExtracted = sessions.find((s) => s.id === sid)
      if (byExtracted) return byExtracted
    }
  }
  return null
}
