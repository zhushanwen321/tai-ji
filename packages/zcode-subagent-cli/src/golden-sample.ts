// src/execution/engine/engines/zcode/golden-sample.ts
//
// golden 语料内嵌副本（2026-09 收缩：CLI spawn 链删除后只剩 app-server 通道语料——
// spawn 单 JSON 样本（ZCODE_GOLDEN_STDOUT）随 probe 干跑/spawn 回归一并删除）：
//
//   app-server NDJSON 帧序列（R3，D8-②）：常驻通道的 golden 帧序列语料，四类样本
//   （create 应答 / 推送流 / 终态帧 / read 应答，附录 A.2 任务生命周期帧序）。
//   来源：按 A.2 协议权威 + 旧 zsw 实现真机抓包形态合成（非实录，fixture _meta
//   如实标注）；真机冒烟后替换。fixture __golden__/zcode-golden-appserver.json
//   是采集 SSOT，此处为运行时副本，更新样本需同步改两处（session-channel 测试
//   diff 校验）。

// ============================================================
// [②app-server] NDJSON 帧序列语料（R3，附录 A.2 帧序逐字）
// ============================================================

/** 四类样本的结构（与 zcode-golden-appserver.json 的 frames 字段一一对应）。 */
export interface AppServerGoldenFrames {
  /** ① session/create 应答帧（NDJSON 单行；projection.sessionId 恒 "unknown" 勿用）。 */
  createResponse: string;
  /** ④ 推送流帧（NDJSON 逐行：state.updated / stream.chunk 无文本 / session/event delta 有文本）。 */
  pushStream: string[];
  /** ⑤ 终态帧（NDJSON 逐行：v4 telemetry turn.terminal 权威 + session/event 收尾帧全文/usage）。 */
  terminal: string[];
  /** ⑥ session/read 应答帧（NDJSON 单行：messages[].parts[]，text 全文 + step-finish tokens）。 */
  readResponse: string;
}

/** [②app-server] golden 帧序列内嵌副本（采集 SSOT = zcode-golden-appserver.json，双副本 diff 防漂移）。 */
export const ZCODE_APPSERVER_GOLDEN: AppServerGoldenFrames = {
  createResponse:
    '{"session":{"sessionId":"sess_golden_r3_01"},"projection":{"sessionId":"unknown","status":"idle","turnCount":0,"totalTokenCount":0,"contextUsed":0,"contextWindow":1000000}}',
  pushStream: [
    '{"method":"state.updated","params":{"sessionId":"sess_golden_r3_01","patch":{"status":"running"},"reason":"prompt_started"}}',
    '{"method":"v4/telemetry/event","params":{"kind":"stream.chunk","channel":"text","chunkLength":6,"firstChunk":true,"assistantMessageId":"msg_golden_r3_01"}}',
    '{"method":"session/event","params":{"sessionId":"sess_golden_r3_01","payload":{"delta":"你好","assistantMessageId":"msg_golden_r3_01"}}}',
    '{"method":"v4/telemetry/event","params":{"kind":"stream.chunk","channel":"text","chunkLength":1,"firstChunk":false,"assistantMessageId":"msg_golden_r3_01"}}',
    '{"method":"session/event","params":{"sessionId":"sess_golden_r3_01","payload":{"delta":"，","assistantMessageId":"msg_golden_r3_01"}}}',
    '{"method":"session/event","params":{"sessionId":"sess_golden_r3_01","payload":{"delta":"任务完成","assistantMessageId":"msg_golden_r3_01"}}}',
  ],
  terminal: [
    '{"method":"v4/telemetry/event","params":{"kind":"turn.terminal","status":"success"}}',
    '{"method":"session/event","params":{"sessionId":"sess_golden_r3_01","payload":{"response":"你好，任务完成","usage":{"inputTokens":12599,"outputTokens":17}}}}',
  ],
  readResponse:
    '{"messages":[{"info":{"role":"user"},"parts":[{"type":"text","text":"做点什么"}]},{"info":{"role":"assistant"},"parts":[{"type":"text","text":"你好"},{"type":"text","text":"，任务完成"},{"type":"step-finish","tokens":{"input":12599,"output":17,"reasoning":0,"cache":512,"total":12616}}]}]}',
};
