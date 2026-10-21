# taiji 验收剧本索引（feature map）

本目录是 taiji 用户可见功能的验收剧本登记处：每个功能一个文件，写清用户入口、驱动步骤、期望终态与坑。驱动真实实例前先读本 README 的基线前置与证明标准，再读目标功能的剧本。

剧本的权威源关系：`docs/testing/` 分域手册是 testid 清单与组件结构的权威，剧本引用它们不复制；剧本独有的增量 = 用户视角的入口枚举 + 端到端驱动步骤 + 可观察终态。

## 基线前置

- 按 [SKILL.md](../SKILL.md) §1 启动实例并等三条就绪判据全过（runtime.port / CDP URL 归属 / 扩展装载日志）。
- 跑 `node .agents/skills/verify-taiji/scripts/doctor.mjs <repo> [--data-dir <dir>]` 全绿才驱动；驱动中出异常先 doctor 再继续。
- 对话类功能（需要 LLM 回复）用 faux 装配实例（SKILL.md §1.1）；纯 UI 功能（侧栏 / 设置）常规实例即可。
- 端口与数据目录每次查实际值，不背数字；同 worktree 同时只驱动一个实例。
- 只驱动自己启动（或明确接管）的实例；连错实例的症状是「改了代码看不到变化」，doctor 的 CDP URL 判定是解药。

## 驱动约定

- 选择器 `data-testid` 优先（清单在 `docs/testing/`），其次 ARIA role + name，最后受控文本锚点；禁坐标。
- contenteditable 输入用 `pressSequentially`；Popover/Modal 全局查（portal 到 body）。
- 等状态不 sleep：用带 timeout 的可见性断言等终态。
- 破坏性动作（删除 / 归档 / 覆盖设置）只对 verify 数据目录里的自建实例做；常驻实例目录不动。

## 证明与跳过上报

- 每个验收点抓三件套证据（截图 + DOM 断言输出 + 磁盘副作用），落 `~/.agents/skill-data/verify-taiji/<worktree>/<run-id>/<feature>/`，配 `report.md` 记录覆盖与未覆盖。
- 剧本要求的步骤走不通时：原样报告失败 + 前置缺失原因，写进该功能 Gotchas；**禁止弱化或改写剧本硬凑通过**。
- 一个入口点验不到不得记为「经另一入口已验证」；不可达项记 `verified-unreachable` + 前置缺失（如需要 OS 原生对话框、需要真实 provider 凭证）+ 尝试过的路径。

## 剧本文件合同

每个功能文件：H1 标题 + 一段用户可见行为描述，然后固定四个 H2 段，顺序不可变：

1. `Sub-features` — 短 ID + 一行行为说明；
2. `How to get to it (user POV)` — 全部用户入口（按钮 / 快捷键 / 菜单）；
3. `Driving it with browser-automation (CDP)` — 以 `Preconditions:` 开头，之后每条 = 用户动作 + 精确驱动命令 + 可观察结果；
4. `Gotchas` — 会浪费或废掉一次验收的坑。

实现细节不进剧本：只写用户路径、稳定选择器、前置状态、命令、可观察终态。

## Features

- [新建任务](./new-task.md) — Landing 态、选目录、选分支、首发提交建 session。
- [多会话管理](./session-management.md) — 会话列表、切换、归档与恢复、彻底删除、右键菜单。
- [对话发送与流式渲染](./chat-stream.md) — 发送、thinking/工具/文本流、变更集、中断与 steer。
- [设置页 provider 管理](./settings-provider.md) — 打开设置、provider 列表、展开、设默认、删除。
- [统一提问表单](./ask-user-form.md) — agent 提问浮层（ask_user 工具触发的 FormOverlay）。
