/**
 * coordination —— 消息入站路由与协同（T&C 层，F6 统一出口）。
 *
 * 组成（架构文档 §5.2）：
 * - route-inbound.ts：ROUTE_TABLE 声明式路由 + pending 分流 + effect 兜底（IF1/IF2/IF4/DM3）
 * - subscription-state.ts：per-session 订阅状态 SSOT（IF5/DM2）+ seq 协议 SSOT
 *   （evalSeqGap 判定 + seqGate 簿记/基线推进，D1 归位，原 seq-gap.ts 已并入）
 * - presence.ts / lease.ts：全局协同态占位（C4 deferred，实现留待 connection-lifecycle slice）
 */
export * from './subscription-state'
export * from './route-inbound'
export * from './presence'
export * from './lease'
