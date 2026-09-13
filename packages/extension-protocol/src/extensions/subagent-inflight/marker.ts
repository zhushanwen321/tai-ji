/**
 * subagent 在途上报的 title marker。runtime event-adapter（u7b）检测此 marker
 * 区分在途上报与普通 select；pi 侧壳层（@zhushanwen/pi-subagent-workflow 的
 * host/inflight-reporter）经同一 marker 以 fire-and-forget 语义推送
 * SubagentInFlightReport 帧（单一来源，两端口径必然一致）。
 *
 * NUL 前缀确保不会与 extension 正常的 select title 冲突。
 * 与 ASK_USER_MARKER / SESSION_MANAGER_MARKER / BRIDGE_MARKER 同理。
 *
 * 设计权威源：docs/design/crash-forensics-and-watchdog.md §3.3 D5
 * 「在途判定谓词 + 求值位置」——extension 聚合上报通道的协议面（u7a）。
 */
export const SUBAGENT_INFLIGHT_MARKER = '\x00XYZ_SUBAGENT_INFLIGHT'
