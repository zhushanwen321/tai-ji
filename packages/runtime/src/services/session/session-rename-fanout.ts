/**
 * session-renamed 事件扇出（rename-session-three-modes 设计 D4 的可测提取）。
 *
 * 组合根 index.ts 的 onSessionRenamed 注入点闭包原先只做 setLabelCache——显示侧扇出
 * 缺口：rename 落库成功但侧边栏不刷新，直到下一个无关操作触发整表广播。D4 修复 =
 * label 回写后追加 broadcastSessionList（行为契约对齐手动 rename 先例
 * session-message-handler 的 handleSessionRename，session-message-handler.ts）。
 *
 * 提取为本模块的原因（agent-settled-fanout 同款先例）：index.ts import 即执行
 * main()，闭包不可直测；扇出语义（先写后广播顺序 + 清名 basename 回落）需要
 * 单测钉住。
 *
 * 同步调用安全性（设计 P3 单测级核验结论）：broadcastSessionList 只读 session 状态
 * + 发 WS 帧，无 pi 事件重入链路；若抛错由 EventInterpreter.interpret 的 per-event
 * try/catch（W1 隔离）吞掉并记日志，批次继续——事件流主链不受广播失败影响，无需
 * 微任务尾部调度降级。
 */
import { basename } from 'node:path'

export interface SessionRenamedFanoutDeps {
  /** 内存 label 写入（sessionService.setLabelCache——session_info_changed 事件路径唯一写方）。 */
  setLabelCache: (sessionId: string, label: string) => void
  /** 取 session cwd（basename 回落用；sessionService.getSessionCwd）。 */
  getSessionCwd: (sessionId: string) => string | undefined
  /** 整表广播（server.broadcastSessionList——config.sessions 帧全连接送达，多窗一致）。 */
  broadcastSessionList: () => void
}

/**
 * 构造 onSessionRenamed 处理器：label 回写（清名回落 basename 派生）+ 整表广播。
 *
 * 顺序契约：先 setLabelCache 后 broadcast——整表广播现算直读内存 session.label
 * （buildSessionListMsg → getActiveSummaries → toSummary），顺序颠倒会广播旧名。
 */
export function createSessionRenamedHandler(
  deps: SessionRenamedFanoutDeps,
): (sessionId: string, name: string | undefined) => void {
  return (sid, name) => {
    // 清名事件（name === undefined，pi session-manager trim 归一后字段缺失）：回落
    // basename(cwd) 派生，与 scanner 兜底（s.name ?? basename(s.cwd)）及 create/fork
    // 初始 label 同语义。不写空串——空 label 会以内存真值形态盖掉 basename 显示，
    // 重启后 scanner 又变回 basename，破坏 live ≡ reload。空串 name（≠ undefined）
    // 原样透传（?? 只捕 undefined，pi trim 归一后本不该出现）。cwd 缺失（session 已
    // 不在内存 Map）时 setLabelCache 自身 no-op，回退 '' 无显示副作用。
    deps.setLabelCache(sid, name ?? basename(deps.getSessionCwd(sid) ?? ''))
    deps.broadcastSessionList()
  }
}
