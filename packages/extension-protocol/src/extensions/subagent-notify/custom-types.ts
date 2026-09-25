/**
 * subagent-workflow 通知通道的 custom_message customType 词表（单源）。
 *
 * 契约两端（值逐字节依赖，改名 = 跨侧破坏性变更）：
 *   - 写侧：@zhushanwen/pi-subagent-workflow extension（workflow 收口通知 / bg-notify
 *     送达 / 定向消息留痕，经 pi.sendMessage 落 custom_message entry 进 session JSONL）
 *     与 @zhushanwen/subagent-core（notifier 送达 + notify ledger 默认通道）；
 *   - 读侧：taiji 三层——@taiji/shared（COMPLETE_NOTIFY_CUSTOM_TYPES display 覆写
 *     集合 + parseSubagentDirective 判型）、runtime（event-interpreter W18 失效信号 /
 *     subagent-extractor legacy 扫描）、core（notify-summary 边界聚合判据）。
 *
 * 历史上双侧各持裸字面量、零跨侧锚定（值相等靠手工同步，commit 21578c74f 在案）。
 * 收敛本单源后两侧 import 同一常量；等值锁 = 壳 __tests__/contract.notify-custom-types.test.ts
 * （值锚定 + 生产码不得本地重定义，防镜像回潮）。
 *
 * 注意与 worker 协议帧的 `type: "workflow-result"`（subagent-core worker-message-pump /
 * worker-script-builder 的 postMessage 帧 type）是同名不同域——那是引擎进程内 RPC 形状，
 * 不跨 pi session 边界，不进本词表。
 */

/** workflow run 收口通知的送达 customType。runtime event-interpreter 按它识别 run 完成
 *  并驱动 W18 workflow-record 失效信号；shared 完成通知 display 覆写集合亦按它收录。
 *  与 SUBAGENT_BG_NOTIFY_CUSTOM_TYPE 通道互斥（互用会让失效信号误判通道语义）。 */
export const WORKFLOW_RESULT_CUSTOM_TYPE = 'workflow-result' as const

/** subagent 后台完成通知的送达 customType（notifier 单条/合批 + notify ledger 默认通道；
 *  壳 index.ts 的 registerMessageRenderer 同按它注册 TUI 渲染）。legacy 链路的
 *  subagent-extractor 磁盘扫描、shared display 覆写集合均按它判型。 */
export const SUBAGENT_BG_NOTIFY_CUSTOM_TYPE = 'subagent-bg-notify' as const

/** subagent 定向消息留痕的 customType（composer 四符号 `@` 定向对话：GUI 经 client.prompt
 *  触发 /subagents message，成功派发后落 custom_message entry——一 entry 双消费：主 agent
 *  上下文 + renderer 定向气泡）。shared parseSubagentDirective / runtime display 覆写消费。 */
export const SUBAGENT_DIRECTIVE_CUSTOM_TYPE = 'subagent-directive' as const
