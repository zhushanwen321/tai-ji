# resume 显式 model 参数端到端接线（subagent-model-switch 决策七档 1 后续项）

状态：**已解决（2026-10-07 收尾轮接线，commit f24bcee1c）**——三入口透传 + core 统一覆盖记账落盘，端到端贯通。

- 语义裁决（收尾轮，F1-26 两候选的第三形态落定）：**显式 resume 参数本身就是用户覆盖意图的一次表达**，经与 setModel 补切相同的 model-override 记账通道落盘——「resume 带模型」与已真机证真的「补切 + 无参 resume」两步构造性等价。覆盖记账仍是唯一意图源（不新增第二意图源，派发侧消费走既有 rebuildRunOverride 表 miss → journal 折叠 → 内存回填通道，零新增消费面）；不变量 2 由 fold replace-not-stack 构造性满足（resume 时刻的覆盖替换此前值，与补切时序语义一致），无语义边界冲击。
- 落地面：① core resumeRun——锁段内格式闸（malformed ref 干净拒绝，先于一切写动作）→ run-resumed 转移落盘后、接管前直写 model-override 帧（journal 第三合法写点，三处登记注释同步；失败走接管失败同款回滚围栏，run 回 interrupted 可重试，不留半截覆盖的 running 态）；② 三入口——tool actionResume 透传（含 run-action 同款目录预检）、`/workflows resume <runId> [model]` TUI verb、RPC action model 字段；参数描述与 resume 文案同步（F1-26 收窄措辞撤位）。
- 用户路径（接线后形态）：中断后单步 `resume + model B` = 覆盖记账落盘 + 重派全部吃 B + 后续无参 resume 沿用 B（跨 resume 存续，与「补切」形态语义一致）。

- 现状（读码核实）：core 协议面已就位——`ResumeRunOptions.model` 在位（`packages/subagent-core/src/orchestration/resume-run.ts:305`，canonical ref；生效值三档回落单点在 assertResumeEligibility：`options?.model ?? journal 覆盖记账 ?? run-created 模型`，resume-run.ts:460），但**三个入口零传参**：斜杠命令 resume（`extensions/universal/subagent-workflow/src/interface/command/commands.ts:137`）、带参 RPC 分支（同文件 `:195`）、tool actionResume（`extensions/universal/subagent-workflow/src/interface/tool/tool-workflow.ts:576`——options 构造仅 time/tokens/args/journalDir/host，无 model 透传）。且**派发侧覆盖表通道不消费 `run-resumed.model`**——journal fold 明说不读该字段（`jsonl-run-store.ts:425`「resume 的显式覆盖已由 core 写进 run-resumed 帧，本折叠只表达 record 事实」），重派生效走宿主覆盖表（决策六②）；run-resumed.model 目前仅观测面落盘。
- 用户路径（现状已闭环，真机证真）：中断后对该 run 下达 setModel 补切（写覆盖记账）+ 无参 resume 吃覆盖——A5 场景 5 两子场景（workflow 重启 resume / chat 重启续聊）真机验证通过。本登记不阻塞任何用户场景，缺的只是「resume 单步携带模型」的显式参数通路。
- 接线量级（后续项实施单元清单）：① tool-workflow actionResume 透传（params 增 model 参数 → options 构造补 `model` 字段，参数描述与 resume 文案同步）；② resumeRun 写 model-override 帧统一通道——显式参数生效值落盘后进派发侧消费通道（当前覆盖表通道的唯一意图源语义保持，不新增第二意图源）；③ 不变量 2 语义边界复核（同一 run 至多一个用户覆盖值——显式 resume 参数与覆盖记账的合并/替换关系须先设计裁决：resume 参数升格为用户覆盖会冲击「覆盖记账是当前用户意图唯一权威」（设计 §7.2），两候选修法的语义代价评估见裁决记录 F1-26）。
- 关联：设计文档 `.tmp/tech-design/subagent-model-switch.md` §6.7 档 1 协议预留标注；验收场景 3 已按补切形态改写。
