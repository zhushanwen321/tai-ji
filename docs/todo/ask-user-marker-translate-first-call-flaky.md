# ask_user 首次调用 marker 翻译失败（间歇性）

状态：未解决（观察到 1 次，画布 D3 验收 A1 场景，2026-10-15）

## 现象

问题解决画布 D3 验收 A1（独立 dev 实例 + 真实 pi 会话，模型 MiMo-V2.6-Flash）中，某会话 ask_user 工具**首次**调用返回错误 `Tool ask_user questions not found`（marker 翻译失败——taiji runtime 侧未按预期将 pi 的 ask_user 工具调用翻译进 marker 通道）；同一会话**第二次** ask_user 调用正常挂起等待用户作答。旁证：另一会话（NAS 场景）ask_user 首次调用即正常。

## 疑点

- 首调失败、二调正常的形态指向：扩展加载时序竞态（marker 登记先于/晚于首次工具调用到达）或翻译表查找的初始化窗口
- 观察样本 1 次，未复现；发生时同会话上下文曾出现 xiaomi 服务端连续 400（环境噪声），是否相关未验证

## 复现线索（来自 A1 验收产物）

- pi stdout 日志：`<数据目录>/a1-inspect-ycyzw4_h/logs/pi-*.jsonl`（验收实例数据目录，可能已随验收清理）
- 过程记录：`.tmp/dev-flow/problem-solve-canvas.runlog/inspect-a1.md`
- 验收判定书：`.tmp/dev-flow/verify/artifacts-A1/verdict.json` deviations 第 4 条

## 待办

复现路径确认后排查 `extensions/universal/ask-user` 与 runtime marker 通道翻译链的首次调用窗口。
