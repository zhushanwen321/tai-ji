# resume 档 1 补收的结构化形态缺失（检查点 7）

## 背景与现状

workflow-run-resume-revision 设计包 D8 三档恢复的档 1（结果补收）路径，对结构化调用（带 schema 的 agent() 调用）存在结果形态缺失：活体链 schema 调用的 `AgentResult.parsedOutput`（校验后对象）会随 agent-settled 帧落 record 流（`workflow-dispatch.ts` / `run-orchestration.ts` 写入面），但 resume 时档 1 补收帧只带 `extractAssistantTextContent` 提取的正文文本（`resume-run.ts` 补收帧构造处，无 parsedOutput 字段）；worker 侧回放缓存与活体消费恒 `parsedOutput ?? content` 优先（`worker-script-builder.ts` 两处）——schema 调用经档 1 补收后，重放侧脚本拿到原始 JSON 文本串而非校验后对象，且无测试覆盖。

**语义边界（2026-09-29 用户澄清）**：这不是活体验收降级——执行时 schema 验收门禁（structured-output 工具校验失败 → steer 回喂同一 agent 重试 → 同签名失败 3 次硬终止，`workflow-hook.ts`）没有「校验不过当纯文本用」的路径，本项不改变它。缺失的是「已通过验收的结果」在补收通道里的对象形态。用户裁决（2026-09-29）：**schema 调用的结果必须是对象形态，没有文本回落选项**——按此标准本项应修（拿不到对象形态就不该判档 1），暂留 todo 待排期。

影响窗口窄：需同时满足「schema 调用 + assistant 回复已落盘 + 后续崩溃 + resume 判入档 1」。

## 附带隐患（2026-09-29 核实发现，推断未完全核实）

档 1 判据（`classifyResumeTierFromContent`）只看「最后一条 assistant 回复完整且带正文」，**不校验该回复是否通过了 schema 验收**——若崩溃恰发生在「校验失败轮已落盘、steer 重试未完成」的窗口，补收可能把未通过验收的文本当结果回放给脚本。修复时必须一并封住（补收前按 schema 校验，或识别未验收形态改判档 2）。

## 实现要点（方向 A，2026-09-29 建议）

- 补收路径提取对象形态：从 pi 会话文件提取 structured-output 工具调用块的工具参数——「工具调用 + 配对的成功 toolResult」双证据确认校验通过，参数即 parsedOutput。
- **拿不到可信对象形态 → 不判档 1，改判档 2 续写重花**（重新生成、重新走完整验收门禁——回到「没有降级选项」语义，重花的 token 成本即诚实成本）。
- 补测试：schema 调用形态的档 1 补收用例（断言重放侧拿到对象形态）+ 未验收轮不补收用例（断言改判档 2）。
- 来源：设计 §5 待验证检查点 7（D4 核实发现，2026-09-29；用户裁决留 todo 待排期）。
