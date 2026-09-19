/**
 * SessionSummary 投影组装（自 session-service.ts toSummary 行为保持抽取）。
 *
 * 为什么独立函数：toSummary 是「IManagedSessionView → SessionSummary」的纯投影
 * （git 信息读 + bare workspace 检测 + usage 快照派生 + binding 内存态透传），不依赖
 * Facade 其余状态——gitInfoReader 与 replicated states 读点参数化后即可模块级化。
 * Facade 保留同名方法一行委托（ISessionService/窄接口契约面不变）。
 */
import type { SessionStatus, SessionSummary } from '@taiji/shared'
import type { IGitInfoReader } from '../ports/git-info.js'
import type { IManagedSessionView } from './types.js'
import type { ManagedSession } from './session-internal.js'
import type { SessionReplicatedStates } from './session-state-projection.js'
import { detectBareWorkspaceCached } from '../worktree/workspace-detector.js'

export function buildSessionSummary(
  s: IManagedSessionView,
  gitInfoReader: IGitInfoReader,
  getReplicatedStates: (sessionId: string) => SessionReplicatedStates | undefined,
): SessionSummary {
  const git = gitInfoReader.readGitInfo(s.cwd)
  return {
    id: s.id, label: s.label, cwd: s.cwd,
    gitBranch: git?.branch, gitIsWorktree: git?.isWorktree,
    // R1：复用 WorkspaceDetector 检测 .bare workspace（带缓存），填 isBareWorkspace
    // 供前端 Landing.vue 派生「新建 worktree」动作项显隐。
    isBareWorkspace: detectBareWorkspaceCached(s.cwd),
    status: s.isGenerating ? ('active' as SessionStatus) : ('idle' as SessionStatus),
    lastActiveAt: s.lastActiveAt, modelId: s.modelId,
    thinkingLevel: s.thinkingLevel,
    // W10：tokenCount 派生自 usage 实例快照（context 占用口径——事件链路三条路径的
    // totalTokens 与 inputTokens 同值直出，快照 inputTokens 保持同语义）。旧
    // session.tokenCount 直写（applyContextUpdate）已删，字段退化为恒 0 派生基线
    // （types 必填）；磁盘 session（非 active）无实例，fallback 字段值。
    tokenCount: getReplicatedStates(s.id)?.usage.get()?.inputTokens ?? s.tokenCount,
    hidden: s.hidden,
    parentSession: s.parentSession,
    forkEntryId: s.forkEntryId,
    handedOffTo: s.handedOffTo,
    sessionFile: s.sessionFilePath,
    // W-RT-4/§4.2：active session 的 launchPresetId 透传到 summary（内存态与 sidecar 并列）。
    // ManagedSession 实例携带此字段；普通 IManagedSessionView 无此字段时为 undefined（安全）。
    launchPresetId: (s as ManagedSession).launchPresetId,
    // F1 披露（设计 `.tmp/tech-design/mode-system-composer-density.md` §7.5 E4）：restore 回落
    // 到 builtin:full 的事实随内存态透传（scanner 磁盘路径无此字段——回落态是「本进程本次
    // 运行」的内存态事实，进程重开即归零，不持久化，避免「未重启也声称已回落」的假陈述）。
    launchPresetFallbackTo: (s as ManagedSession).launchPresetFallbackTo,
    // D14 语义修正：归属 project 透传到 summary（内存态兑底，sidecar 扫描路径在 scanner）。
    projectId: (s as ManagedSession).projectId,
    // B-2：agent-managed 标记透传——list 按 spawnSource/parentAgentSessionId 过滤时
    // active session 走本路径（scanned 路径被 activeFilePaths 排除），漏透传 = 过滤失效。
    spawnSource: (s as ManagedSession).spawnSource,
    parentAgentSessionId: (s as ManagedSession).parentAgentSessionId,
  }
}
