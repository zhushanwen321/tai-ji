/**
 * subagent 虚拟 session id 判断（w6 从 renderer stores/subagent.ts 抽出）。
 *
 * isSubagentVirtualId 判断 session id 是否为 subagent 虚拟 id（格式 'subagent:<mainSid>:<subId>'）。
 * 纯函数，供 TurnSummary 等组件决定是否隐藏 fork/handoff 按钮（subagent session 不支持 fork/handoff）。
 *
 * 实现单源：SSOT 在 @taiji/shared/virtual-session-id（跨层协议级约定，其头注释明文
 * 「store（renderer）与 ui 组件均从此 import，禁止重复定义」）。此处 re-export 消除 ui 侧
 * 重复实现（S4 B8），对齐 renderer stores/subagent.ts 既有 re-export 形态。
 */
export { isSubagentVirtualId } from '@taiji/shared'
