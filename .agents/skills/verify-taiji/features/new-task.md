# 新建任务

用户开启一个 AI coding session 的入口旅程：从空 Landing 态选工作目录（可选分支与模式），首次发消息时才真正创建 session 并进入对话流。统一延迟 create 是核心设计——点新建不建 session，首发提交才建，避免僵尸空会话。

## Sub-features

- `nt-landing` ⌘N / 新建按钮进入 Landing 态（空 composer 卡片 + directory/branch chip 行）。
- `nt-dir-select` 点 directory chip 弹工作区选择浮层，选中回灌目录名。
- `nt-branch-select` git 目录下点 branch chip 弹分支选择（非 git 目录不出现 branch chip）。
- `nt-first-submit` 输入消息发送 → 创建 session → 发消息 → 离开 Landing 进入对话流。
- `nt-creating` 首发提交点击同帧出现创建中过渡视图（不等 pi 启动完成）。

## How to get to it (user POV)

- 侧栏「新建」按钮或 ⌘N。
- 全新实例（无历史 session）首屏直接是 Landing 态。

## Driving it with browser-automation (CDP)

Preconditions:

- doctor 全绿；faux 装配实例（首发提交要真实 LLM 轮次，faux 脚本第一 step 给 `{ "text": "...", "stopReason": "stop" }`）。
- 工作目录用真实 git 仓库（faux 数据目录里 recentWorkspaces 为空时，浮层走「打开其他目录」= OS 对话框不可自动驱动；预置办法见 Gotchas）。

- **进入 Landing。** `page.getByTestId('new-task-landing')` 可见，`composer-box` 可见，`chip-directory` 可见。
- **选目录。** 点 `chip-directory` → `dir-select-popover` 可见 → 点某 `workspace-item` → 浮层关闭、`chip-directory` 文本变为所选目录末段名。
- **git 分支 chip。** 选中 git 仓库后 `chip-branch` 出现；点开 → `branch-select-popover` 列出分支。
- **首发提交。** 点 `getByRole('textbox')` 聚焦，`pressSequentially('验收消息')`，点 `getByTitle('发送 · ⏎')`。同帧 `new-task-creating` 出现（过渡视图）；create 完成后 `new-task-landing` 消失（`toHaveCount(0)`）、panel 态 `composer-box` 仍在。
- **回复到达。** faux 第一 step 的 text 出现在对话流（`block-text` 可见）。user 气泡文本与 assistant 回复文本可能相同字符（faux 脚本里让回复文本区别于输入文本，避免 getByText 双匹配）。
- **副作用取证。** `ls <dataDir>/ext-sessions/` 出现新 `<sessionId>/` 树；pi session 文件在首个 assistant 到达后才落盘（之前不存在是**正确行为**，不要当失败）。
- **Proof。** 截图（Landing 态 + 对话流态各一张）+ DOM 断言输出 + `ext-sessions/` 树清单。

## Gotchas

- `chip-directory` 在有历史 session 的实例上会被预填最近 session 的目录（不是空态「选择目录」）；全新 verify 数据目录才是真空态。
- recentWorkspaces 为空（未用 seed-faux 预置的全新数据目录）时浮层只有「打开其他目录」（`action-open-dir`）→ OS 原生对话框无法自动化，该路径记 `verified-unreachable`。seed-faux.mjs 已预置 `<repo>` 为最近工作区，浮层默认有可点项。
- pi session 文件延迟写入：建 session 后立刻断言 `agent/` 下 session 文件存在会假失败；正确断言时点 = assistant 回复到达后。
- contenteditable 输入必须 `pressSequentially`（`fill` 不触发 input 逻辑）。
- popover portal 到 body，全局查 testid。
- OS dialog（`action-open-dir`）、新建分支 modal 的完整链路含人工步骤的，标注后跳过。
