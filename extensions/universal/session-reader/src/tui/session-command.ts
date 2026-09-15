import type { AutocompleteItem } from '@earendil-works/pi-tui'
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import { SessionManager, type SessionInfo } from '@earendil-works/pi-coding-agent'
import { toCandidate, DEFAULT_LIMIT } from './hash-provider.js'

/**
 * M4 TUI 层：/session-pick 命令（design 附录 P-hash-trigger 降级兜底 + 非 # 场景入口）。
 *
 * 两条用途：
 * 1. # autocomplete provider 在真实 TUI 触发失败（⛔ P-hash-trigger）时的降级入口——
 *    用户输入 /session-pick 走列表选择，选中后插入 # 完整 uuid
 * 2. 非 # 主动查找场景（用户明确想浏览 session 列表）
 *
 * 显示数据源与 # 弹窗统一（2026-08-10 重构）：`SessionManager.listAll(cwdSessionDir)`，
 * limit 对齐 10（design G6），cwd-scoped + uuid 片段过滤（design G1）。
 *
 * **insertText**：与 hash-provider 一致，命令参数 value（剥 #）和 handler 选中后插入的
 * # 引用都用完整 uuid。完整 uuid 天然全局唯一，findSessions `sessionId.includes(query)`
 * 子串匹配零碰撞，无需全局扫算唯一前缀。
 *
 * cwdSessionDir 注入（同 hash-provider，零 pi 依赖核心逻辑，可单测）。
 */

/** label 追加的短 uuid 长度（uuid v7 时间前缀，同目录同毫秒创建概率可忽略，消歧足够）。 */
const SHORT_UUID_LEN = 8

/** /session-pick 命令配置：返回结构类型（description + 参数补全 + handler），
 * 形态等价于 RegisteredCommand 减 name/sourceInfo（这两项由 pi 注册方提供），
 * 按仓内现状写为内联类型而非 Omit<>。 */
export function createSessionCommand(
  getCwdSessionDir: () => string,
): {
  description: string
  getArgumentCompletions(argumentPrefix: string): Promise<AutocompleteItem[] | null>
  handler(args: string, ctx: ExtensionCommandContext): Promise<void>
} {
  return {
    description: 'Pick a session and insert a #uuid reference into the editor.',
    async getArgumentCompletions(argumentPrefix) {
      const trimmed = argumentPrefix.trim()
      // 目录未就绪（无 live session 上下文，getCwdSessionDir 返回空串）→ 空手返回，绝不调
      // listAll('')——pi 的 listAll 对空字符串 falsy 走默认全盘分支（3488 项 / ~8s，会让补全
      // 卡死；同款 guard 见 hash-provider provideHashCandidates）
      const cwdSessionDir = getCwdSessionDir()
      if (!cwdSessionDir) return null
      const all = await SessionManager.listAll(cwdSessionDir)
      // uuid 片段过滤（与 # 弹窗一致）；空 prefix → recent（listAll 已按 modified 倒序）
      const filtered =
        trimmed === '' ? all : all.filter((s) => s.id.includes(trimmed))
      const top = filtered.slice(0, DEFAULT_LIMIT)
      if (top.length === 0) return null
      // value 用完整 uuid（剥 # 后，命令参数位置不带 #）
      return top.map((s) => {
        const c = toCandidate(s)
        return { value: c.insertText.slice(1), label: c.label }
      })
    },
    async handler(args, ctx) {
      const trimmed = args.trim()
      // 同 getArgumentCompletions 的空串 guard：无 live session 上下文时按零匹配处理，
      // 不触发 listAll 全盘分支
      const cwdSessionDir = getCwdSessionDir()
      if (!cwdSessionDir) {
        ctx.ui.notify('未找到匹配的 session。', 'warning')
        return
      }
      const all = await SessionManager.listAll(cwdSessionDir)
      const filtered =
        trimmed === '' ? all : all.filter((s) => s.id.includes(trimmed))
      const top = filtered.slice(0, DEFAULT_LIMIT)
      if (top.length === 0) {
        ctx.ui.notify('未找到匹配的 session。', 'warning')
        return
      }
      // ctx.ui.select 只接受 string[]、返回选中的字符串。用并行数组 + indexOf 还原 session。
      const labels = top.map((s) => formatSessionLabel(s))
      const chosen = await ctx.ui.select('选择一个 session 插入 # 引用', labels)
      if (chosen === undefined) return
      // chosen 必属 labels（select 契约返回列表成员或 undefined，后者上一行已拦截），
      // indexOf 恒命中——不再保留 idx<0 死防御分支
      const idx = labels.indexOf(chosen)
      // 选中后插入 # + 完整 uuid（剥 # 算片段，再补 # 插入编辑器）
      const frag = toCandidate(top[idx]).insertText.slice(1)
      // /session-pick 提交后编辑器已清空，直接 set # uuid 供用户补完指令再发送；
      // 尾部补空格与 # 弹窗 applyCompletion spacer 语义一致（S-2），避免 #uuid查看 连写被整体当查询串
      ctx.ui.setEditorText(`#${frag} `)
    },
  }
}

/** select 列表单行格式：toCandidate label + 尾部短 uuid（消歧）。
 * 原始 label = `{age桶}{预览截100字}`，不含 uuid：同 cwd 下两 session 首条消息相同且落同一
 * age 桶时 label 完全相同 → ctx.ui.select 返回的字符串经 labels.indexOf 反查会错插 uuid（MF-2）。
 * 追加 uuid 前缀（slice(0, SHORT_UUID_LEN)，uuid v7 时间前缀，同目录同毫秒创建概率可忽略）保证唯一。 */
function formatSessionLabel(s: SessionInfo): string {
  return `${toCandidate(s).label}  ${s.id.slice(0, SHORT_UUID_LEN)}`
}
