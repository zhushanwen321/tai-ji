# resume 档 1 补收的结构化形态降级（检查点 7）

## 背景与现状

workflow-run-resume-revision 设计包 D8 三档恢复的档 1（结果补收）路径，对结构化调用（带 schema 的 agent() 调用）存在形态降级：活体链 schema 调用的 `AgentResult.parsedOutput`（校验后对象）会随 agent-settled 帧落 record 流（`workflow-dispatch.ts` / `run-orchestration.ts` 写入面），但 resume 时档 1 补收帧只带 `extractAssistantTextContent` 提取的纯文本（`resume-run.ts` 补收帧构造处，无 parsedOutput 字段）；worker 侧回放缓存与活体消费恒 `parsedOutput ?? content` 优先（`worker-script-builder.ts` 两处）——schema 调用经档 1 补收后，重放侧脚本拿到原始 JSON 文本串而非校验后对象，静默降级且无测试覆盖。

影响窗口窄：需同时满足「schema 调用 + assistant 回复已落盘 + 后续崩溃 + resume 判入档 1」。

## 实现要点

- 补收路径提取 parsedOutput：pi 会话 assistant 消息的结构化输出字段（对照 session-reader 侧 structured-output 解析的读取形态）→ 补收帧 result 附 parsedOutput。
- 补测试：schema 调用形态的档 1 补收用例（断言重放侧拿到对象形态）。
- 来源：设计 §5 待验证检查点 7（D4 核实发现，2026-09-29）。
