/**
 * session JSONL 的 model_change 尾条目提取器（subagent-model-switch §7.2「实际执行
 * 事实权威」审计口径的读取单点——pi 唯一显式 setModel 写点落盘 entry 的最近值派生）。
 *
 * 落点自 session-file-utils 拆出（2026-10-07 dmg-r1-5：services 层手写 JSONL 尾读
 * 收敛 infra，同批 session-file-utils max-lines 预算无余量，一文件一概念先例同
 * residue-cleanup 族）；扫描骨架复用 session-file-utils 的 scanJsonlFromTail（infra
 * 内部单向依赖，消费方 services 侧经 check_services_infra_import BASELINE_MODULES
 * 登记）。读者归类 = census §6 N16（照实族）。
 */
import { scanJsonlFromTail } from './session-file-utils.js'

/**
 * 单 entry 的显式 model_change 提取（解析落点）。与 session-file-utils 的
 * modelEntryValueOf 的语义分界：只认 pi 唯一显式 setModel 写点落盘的 `model_change`
 * entry（provider / modelId 顶级平铺字段），assistant message 携带的模型不属「最近
 * 一次显式热切换」语义；字段非法（非 string / 空串）→ null（视为不携带切换信息，
 * 扫描继续向前）。
 */
function modelChangeEntryValueOf(entry: Record<string, unknown>): { provider: string; modelId: string } | null {
  if (entry.type !== 'model_change') return null
  if (typeof entry.provider !== 'string' || entry.provider === '') return null
  if (typeof entry.modelId !== 'string' || entry.modelId === '') return null
  return { provider: entry.provider, modelId: entry.modelId }
}

/**
 * 反向读 session JSONL 提取最近一次显式热切换的模型（`model_change` 尾条目）。
 *
 * 取数 = scanJsonlFromTail 骨架 + `{ activePath: true }` 活跃路径裁剪（与
 * extractLatestModelFromJsonl 同款）：分支文件下物理尾逆读会命中被撤子树的 model_change
 * （被撤回合的显示残留），先裁剪再逆扫与 pi 恢复语义对齐；oversize 段不裁（骨架注释口径）。
 * 未命中（文件不存在——pi 首次 flush 前延迟写入 / 扫描窗内无合法条目）按无值返回
 * undefined；错误对等（INVAR-tail-7）不抛。
 *
 * 与 extractLatestModelFromJsonl 的语义分界：那边是「最近生效模型绑定」（model_change 与
 * assistant message 都算，附 thinkingLevel，侧栏扫描第七读）；本函数只认显式 model_change、
 * 拆分返回 { provider, modelId }（shared SubagentRecentEffectiveModel 同构形状，成员详情消费）。
 */
export function extractLatestModelChangeFromJsonl(filePath: string): { provider: string; modelId: string } | undefined {
  const found: Array<{ provider: string; modelId: string }> = []
  scanJsonlFromTail(filePath, (entry) => {
    const value = modelChangeEntryValueOf(entry)
    if (value === null) return false
    found.push(value)
    return true
  }, { activePath: true })
  return found.length > 0 ? found[0] : undefined
}
