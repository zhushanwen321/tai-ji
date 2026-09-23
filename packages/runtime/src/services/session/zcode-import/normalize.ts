/**
 * zcode session id 归一化（session-import-unified 设计 §3.4 T1——U3 先落，U4 转换器
 * import 同源，唯一落点见设计 §3.7「归一化函数唯一落点」：两调用点（候选打标 / 转换
 * header）分属不同交付单元，各内联一份则单边漂移——打标失配即幂等失效）。
 *
 * 背景（为什么必须归一化，D3）：归一化产物是导入落地的 header.id = 幂等键，且必须维持
 * 全仓不变量「session 文件名（剥 .jsonl 后）最后一个 `_` 之后的尾段 == header.id」
 * （image-cache 孤儿判定/删除级联、session-reader 文件名提取、parent-session 兜底匹配、
 * 短名展示共 4 处消费点）。zcode 原始 id 形如 `sess_<uuid>`，`_` 前缀会打破该不变量。
 * pi 侧对 header.id 无格式校验（恢复路径不校验，F1），本函数的字符集是 taiji 自定
 * 约束（pi assertValidSessionId 允许集的真子集，收紧方向安全）。
 */

import { ImportServiceError } from '../import-source.js'

/** 后置条件字符集：字母数字与 `-`，首尾必须字母数字（单字符允许）。 */
const NORMALIZED_ID_RE = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/

/** zcode 原始 id 的已知前缀（宿主库实测全库 `sess_<uuid>`，§2.3）。 */
const SESS_PREFIX = 'sess_'

/**
 * T1 归一化（防二义读法，替换规则无条件施加于结果串）：
 * ① 若以 `sess_` 开头则剥该前缀一次（无前缀不剥；双前缀只剥一次——`sess_sess_x` →
 *    `sess_x` → 步骤② → `sess-x`，函数幂等：normalize(normalize(x)) === normalize(x)）
 * ② 对①结果串全部 `_` → `-`
 * ③ 后置条件校验：非空 ∧ 不含 `_` ∧ 字符集/首尾合法，不满足 →
 *    ImportServiceError('import_invalid_session') fail-fast（错误规格 ③：防 id 值形态
 *    漂移静默打破文件名不变量——静默跳过或宽松放行会让落地文件被自家消费链误解析）。
 *
 * 候选域（D8 排除 subagent_child 后）剥后为裸 uuid（v4），与 pi 自建 uuidv7 域版本位
 * 不相交不撞（§3.4 T1 说明）。
 */
export function normalizeZcodeSessionId(raw: string): string {
  const stripped = raw.startsWith(SESS_PREFIX) ? raw.slice(SESS_PREFIX.length) : raw
  const replaced = stripped.replaceAll('_', '-')
  if (replaced.length === 0) {
    throw new ImportServiceError(
      'import_invalid_session',
      `zcode 会话 id 归一化后为空（原始 id=「${raw}」）：该 id 形态超出已验证域（sess_<uuid>），请升级太极后重试`,
    )
  }
  // 理论不可达（步骤②已全部替换），规格仍显式校验：未来改动②的替换规则时此条件拦截漏网
  if (replaced.includes('_')) {
    throw new ImportServiceError(
      'import_invalid_session',
      `zcode 会话 id 归一化后仍含下划线（原始 id=「${raw}」→「${replaced}」）：破坏「文件名尾段 == header.id」不变量，拒绝导入`,
    )
  }
  if (!NORMALIZED_ID_RE.test(replaced)) {
    throw new ImportServiceError(
      'import_invalid_session',
      `zcode 会话 id 归一化后含非法字符或首尾非字母数字（原始 id=「${raw}」→「${replaced}」，合法集 = 字母数字与「-」且首尾字母数字）：该 id 形态超出已验证域（sess_<uuid>），请升级太极后重试`,
    )
  }
  return replaced
}

/**
 * 候选打标域转换（同一函数别名导出）：listCandidates 的 alreadyImported 打标把原始
 * session.id 映射到太极扫描集（header.id 域 = 归一化域）后比对——直接用原始 id 比对
 * 会失配（设计 §3.7）。与 normalizeZcodeSessionId 同一实现，确保打标域与 U4 转换
 * header 域构造性一致。
 */
export const zcodeCandidateKey = normalizeZcodeSessionId
