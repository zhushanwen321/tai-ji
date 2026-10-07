# B2 D3 A7 real 轨三组失败登记（归因完成，非 B2 引入，待人工复核）

- 状态：未解决（非 B2 引入的既有/环境失败，登记待人工定责复跑）
- 发现时点：2026-10-07 B2 subagent-stream-chunk D3 验收 A7（G3 real 轨）
- B2 无交集佐证（确定性）：`git diff 4bc83d6d6..HEAD` 不含 ask-user 扩展 / event-adapter / btw 链路 / verify-plugin-contract.sh / find-pi-executable / process-manager 任何文件；同窗口 B2 触及的等价性轨（EQUIV-01 76 用例、EQUIV-05）与行为轨（mock 58 用例）全绿。

## 1. ask-user-real A1/A2/A3（3 failed，两次复跑稳定复现）

- 症状：A1 `waitForAskUserRequest` 等 `extension.ui_request`（form/askUser:true）60s 超时；diag（/tmp/askuser-a1-diag.json）显示 `extension.dialog` 帧已到达、tool_call_start 正常——marker select 被适配器按普通 dialog 翻译，未走 ui_request/form 分支
- 失败链：event-adapter marker select 判定 / pi-ask-user 扩展 marker 字面 / 测试预期——三者均在 B2 零改动集
- 处置建议：核对 ask-user 扩展与 runtime 的 marker 常量是否随分支其他特性漂移（ui-redesign 合入窗口）；非 B2 责任面

## 2. btw S7（两次失败、两次失败模式不同）

- 第一轮：主 turn 90s 未 complete，seen types 含 thinking + 多次 tool_call——LLM 在推进但慢（e2e 准则的「推进中非死锁」形态）
- 第二轮：主 turn 早于第 3 轮 btw 完成，窗口重叠断言失败（MAIN_TURN_SLEEP_S=40 未被模型执行满）
- 归因：真实 LLM 行为方差（时长不达标两个方向），主 turn/btw/steer 机制不在 B2 改动面

## 3. PLUGINCONTRACT-01（CT-D1-T1 session.create 失败）

- 症状：契约脚本环境 spawn 的 pi = `~/.nvm/.../bin/pi`（用户全局 npm 版），不识别 `builtin:codemode`/`builtin:mcp`（taiji staged 内置扩展协议）→ pi exit 1 → session.create 报错
- 归因：harness 的 pi 解析落到 PATH 全局版（环境敏感），解析链与脚本均不在 B2 改动面
- 处置建议：契约脚本起 runtime 时应显式注入仓库 resources/pi 解析优先（或清理 PATH 全局 pi 干扰）；mock 残留已排除（无 marker / 无 .bak / 无回执，三证核过）

## 4. TERMINAL-01 T13 跨会话不误清（定责完成：分支既有缺陷，非 B2）

- 症状：切回 A 后 terminal-instance-item 期望 1 实得 0（B 侧 terminal.list 对账后 A 条目丢失）
- 定责实验（决定性）：在 B2 基线 commit 4bc83d6d6 的分离 worktree（real bundle）复跑 T13 **同样失败**——失败先于 B2 全部改动存在
- 复现：HEAD 与 4bc83d6d6 均 2/2 稳定复现（非时序抖动）
- 处置建议：回溯 4bc83d6d6 之前触及 terminal.list 对账范围/会话激活腿的提交（132803b43 等 ui-redesign 线合并窗口嫌疑）；B2 的清理编排接线只挂 delete 链与 subagent 分区键，不在终端域
