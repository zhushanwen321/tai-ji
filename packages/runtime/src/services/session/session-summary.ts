/**
 * SessionSummary 派生组装（自 session-service.ts toSummary 行为保持抽取）。
 *
 * 为什么独立函数：toSummary 是「IManagedSessionView → SessionSummary」的纯派生
 * （git 信息读 + bare workspace 检测 + binding 内存态透传），不依赖
 * Facade 其余状态——gitInfoReader 读点参数化后即可模块级化。
 * Facade 保留同名方法一行委托（ISessionService/窄接口契约范围不变）。
 *
 * W3（会话架构四层分离）：modelId / thinkingLevel / tokenCount 三状态字段已从
 * SessionSummary 删除（状态归状态层 live-state，列表只承载导航），原 tokenCount 的
 * usage 实例快照派生读点（getReplicatedStates 形参）随之退役。
 */
import type { SessionStatus, SessionSummary } from '@taiji/shared'
import type { IGitInfoReader } from '../ports/git-info.js'
import { isGeneratingTurn } from './types.js'
import type { IManagedSessionView } from './types.js'
import type { ManagedSession } from './session-internal.js'
import { detectBareWorkspaceCached } from '../worktree/workspace-detector.js'

export function buildSessionSummary(
  s: IManagedSessionView,
  gitInfoReader: IGitInfoReader,
): SessionSummary {
  const git = gitInfoReader.readGitInfo(s.cwd)
  return {
    id: s.id, label: s.label, cwd: s.cwd,
    gitBranch: git?.branch, gitIsWorktree: git?.isWorktree,
    // R1：复用 WorkspaceDetector 检测 .bare workspace（带缓存），填 isBareWorkspace
    // 供前端 Landing.vue 派生「新建 worktree」动作项显隐。
    isBareWorkspace: detectBareWorkspaceCached(s.cwd),
    // [chat-flow-consistency D1] active 判定读口迁移：isGenerating ≡ isGeneratingTurn(turn)
    //（dispatching+generating 两段；settling 不算 active——收尾中的回合侧栏已可视为结束前夜）。
    status: isGeneratingTurn(s.occupancy?.turn) ? ('active' as SessionStatus) : ('idle' as SessionStatus),
    lastActiveAt: s.lastActiveAt,
    // W3 surface 落地：注册表 surface 透传到 SessionSummary（active 路径记录恒有值——
    // registerSession 缺省 'sidebar'；btw 线显式 'btw'）。磁盘扫描路径的缺省在
    // scannedToSummary（本文件不覆盖该路径）。
    surface: s.surface,
    parentSession: s.parentSession,
    forkEntryId: s.forkEntryId,
    handedOffTo: s.handedOffTo,
    sessionFile: s.sessionFilePath,
    // W-RT-4/§4.2：active session 的 launchPresetId 透传到 summary（内存态与 sidecar 并列）。
    // 字段已收编进 IManagedSessionView（照 handedOffTo 先例）；sidecar 缺失的异常时序下为 undefined（安全）。
    launchPresetId: s.launchPresetId,
    // F1 披露（设计 `mode-system-composer-density` §7.5 E4）：restore 回落
    // 到 builtin:full 的事实随内存态透传（scanner 磁盘路径无此字段——回落态是「本进程本次
    // 运行」的内存态事实，进程重开即归零，不持久化，避免「未重启也声称已回落」的假陈述）。
    launchPresetFallbackTo: (s as ManagedSession).launchPresetFallbackTo,
    // D14 语义修正：归属 project 透传到 summary（内存态兜底，sidecar 扫描路径在 scanner）。
    projectId: s.projectId,
    // B-2：agent-managed 标记透传——list 按 spawnSource/parentAgentSessionId 过滤时
    // active session 走本路径（scanned 路径被 activeFilePaths 排除），漏透传 = 过滤失效。
    spawnSource: (s as ManagedSession).spawnSource,
    parentAgentSessionId: (s as ManagedSession).parentAgentSessionId,
  }
}
