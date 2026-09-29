# TODO：裸 CLI 场景下 zcode 引擎 Provider Registry 缺失成员模型（验收环境阻断）

状态：已登记（2026-09-29，a1a4 真机复跑 run3 复发）——归属 zcode-subagent-cli 包，不阻塞 workflow resume 线的修复登记

## 背景

workflow resume 真机验收剧本（`.tmp/dev-flow/workflow-run-store-convergence.acceptance/a1a4-real-pi-recovery.mts`）经裸 pi CLI 宿主派发成员调用，成员引擎 = zcode（app-server RPC）。run2 与 run3 两次终判均被同一环境类缺陷阻断在成员 session/create：app-server 报 `[-32603] Provider Registry 中不存在 Model: builtin:bigmodel-coding-plan/GLM-5.3-Flash`。run2 终判（`.tmp/dev-flow/workflow-run-store-convergence.acceptance/a1a4/verdict.json` A4_completion 字段）已诊断为「模型目录双登记制：引擎目录 builtin:* 过审后 app-server Provider Registry 仍不识别」，归属 zcode-subagent-cli 包；生产 taiji runtime 装配经 appserver-launcher 的 v2 provider 注入（fs 拦截合并宿主 config）不走此裸链路——此为 handoff 缺陷 3 的既有判定，本轮未复核生产侧。

## 现状（证据链）

- run3（2026-09-29 12:41）：三个成员调用全部在 session/create 被拒（record journal seq4/8/12 三次同因，间隔各约 2.5s——LLM 从未被调用到，非慢/未遵从）；attempt 2 的 markResurrected「no sessionFile anchor」为下游症状（session 从未创建成功，无锚点，无半状态干净中止）。剧本证据 = `a1a4/evidence.json`；保留现场 tmp 目录路径见该文件 preservedTmpRoot 字段（含 record journal / engine-data 引擎制品 / pi session 文件，系统重启后清空）。
- 差分事实：run2（同日 02:56，同一剧本、成员模型同一写死值）三成员派发成功（verdict.json A1 PASS）；两次之间 packages/zcode-subagent-cli 零提交（git log 核实）——引擎链路仓库代码未变，剩余变量是宿主 zcode app 侧状态（具体变化未核实）。
- 宿主 config（`~/.zcode/cli/config.json`）：provider `builtin:bigmodel-coding-plan` 在场（含凭据与 baseURL）；`subagents.builtInModelOverrides.general-purpose` 正是被拒的同一模型 id；`model.main` 指向 `builtin:bigmodel-start-plan/GLM-5.3-Flash`（另一 provider 家族）——宿主侧登记与 app-server Provider Registry 的模型目录不一致。

## 实现要点（届时从这起步）

- 复现锚点：zcode-subagent-cli 的 app-server 客户端（session/create 错误透传处），对比「引擎目录 builtin:* 过审」与「Provider Registry 模型目录」两个清单的来源与刷新时机差异。
- 候选方向：裸 CLI 形态下（无 taiji runtime 注入）让引擎侧对缺失模型给出可操作错误（指向宿主 config 刷新 / 模型目录再登记的恢复动作），或 launcher 侧把宿主 builtInModelOverrides 同步进注册表。
- 关联条目：`engine-default-provider-setting.md`（引擎默认 provider/model 页面化——长期形态）；本条是裸 CLI 验收环境的地板缺口，两者可同批设计。

## 出处

- run2 终判：`.tmp/dev-flow/workflow-run-store-convergence.acceptance/a1a4/verdict.json` A4_completion 阻塞项②（handoff 缺陷 3）
- run3 复发：同目录 evidence.json + verdict-run3.json（2026-09-29）
