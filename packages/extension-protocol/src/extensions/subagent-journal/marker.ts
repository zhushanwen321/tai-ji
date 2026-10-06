/**
 * journal 事件推送的 title marker。runtime event-adapter 检测此 marker 区分
 * journal 事件报告与普通 select；pi 侧壳层（@zhushanwen/pi-subagent-workflow 的
 * host/journal-reporter）经同一 marker 以带回执语义推送 SubagentJournalReport
 * 帧（单一来源，两端口径必然一致）。
 *
 * NUL 前缀确保不会与 extension 正常的 select title 冲突。
 * 与 SUBAGENT_INFLIGHT_MARKER / ASK_USER_MARKER / SESSION_MANAGER_MARKER 同理。
 *
 * 设计权威源：.tmp/tech-design/event-push-channel.md §3.1/§3.4（journal 写入方
 * subagent-core 在落盘提交点经本 marker 通道把新事件批量推给 runtime，通道数量
 * = 1 个，载荷内 domain 字段判别 run/record 两域）。
 */
export const SUBAGENT_JOURNAL_MARKER = '\x00TAIJI_SUBAGENT_JOURNAL'
