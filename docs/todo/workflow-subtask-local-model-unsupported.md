# 工作流子任务不支持 llama.cpp 本地模型

状态：已裁决不修（已知限制显式接受，pi1-disposition-chat-flow 设计 D14⑤ / D8 表 subagent-workflow 行 / 裁决 Q3，2026-10-04）。

- 现状：subagent-workflow 的子任务 pi 进程恒带 `--no-extensions` 启动（`extensions/universal/subagent-workflow/src/host/pi-host.ts`，白名单扩展显式装载，自动发现全关）。pi 0.99.0 起 `--no-extensions` 连内置扩展一起停用，llama.cpp 本地模型的 provider 定义随内置扩展消失——子任务以该模型启动即失败（`Model not found` 形态）。
- 影响面：仅工作流子任务；主对话不受影响（主进程不带该参数，本地模型照常可用）。云端模型子任务不受影响。
- 恢复通道：工作流子任务改用云端模型。临时把本地模型用于子任务需改动 spawn 参数语义（已裁决不做——为本地模型放宽 `--no-extensions` 会把扩展自动发现重新打开，破坏子任务的环境确定性，代价大于收益）。
- 重审触发：上游 pi 若拆分「停用扩展自动发现」与「停用内置 provider」两个维度（或 llama.cpp 定义迁出内置扩展），本限制随之消失，届时移除本登记。
