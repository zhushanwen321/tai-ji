# error turn 收尾后 occupancy dispatching 无活动回升 / 发送位复位迟滞

- 状态：待复现归因（2026-10-24 chat-flow-consistency D3 验收 A4 登记探针双跑：一次 <5s 复位、一次 >60s 滞留且 occupancy 出现无 pi 活动的 dispatching 回升；正式验收轮 a4-final 60s 内正常复位未复现滞留）
- 现象：faux error turn（message.complete{stopReason:error, willRetry=false}）收尾后，发送位停止态存在迟滞形态；滞留时刻 pi 会话 JSONL 无 retry entry、runtime 日志无新 prompt、pi settings retry.enabled=false 已写——dispatching 回升无 pi 侧活动对应
- 排查入口：packages/runtime/src/services/session/event-interpreter.ts（complete{error} 的 occupancy 转移路径）+ message-dispatcher.ts 收尾链；辅证 = blockseq-a4 验收产物目录 console-ws-tail.txt 与探针记录
- 影响：发送位停止态滞留（用户可重试发送，无内容损失）；A4 剧本断言窗 60s 内通过，非交付阻塞
- 复现步骤：node .agents/skills/verify-taiji/scripts/run.mjs .agents/skills/verify-taiji/scenarios/p1-disconnect-selfheal.mjs --name verify-stall --data-dir ~/.taiji-dev/verify-stall --artifacts-dir ~/.agents/skill-data/verify-taiji/fix-chat-flow-order/stall-repro
