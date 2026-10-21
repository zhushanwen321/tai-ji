# 多会话管理

侧栏会话列表的浏览、切换、归档与删除，以及行级右键菜单（停止 / 强制退出 / 标记完成 / 导出）。删除会话 = 整棵会话数据树移出（归档 → 彻底删除两级）。

## Sub-features

- `sm-list` 侧栏「会话」tab 列出全部 session（活跃态高亮 + 未读角标 `session-unread-dot`）。
- `sm-switch` 点行切换活跃 session，对话流内容随切换替换、不串扰。
- `sm-archive` 行 hover 出归档按钮 → 归档 → 侧栏归档计数徽标 +1，行从活跃列表消失。
- `sm-archive-view` 归档入口进归档列表 → 点行看归档摘要（恢复按钮可见）。
- `sm-restore` 归档摘要里恢复 → 会话回活跃列表。
- `sm-context-menu` 行右键出菜单：标记完成 / 导出 jsonl / 引用到输入区 / 停止（两段确认）/ 强制退出（两段确认）。

## How to get to it (user POV)

- 侧栏「会话」tab（`getByRole('button', { name: /^会话/ })`）。
- 行 hover 的归档按钮；侧栏归档入口（徽标 + 按钮）；行右键菜单。

## Driving it with browser-automation (CDP)

Preconditions:

- doctor 全绿；实例里至少两个 session（faux 实例先按 new-task 剧本建两个，或常规实例用既有会话）。
- 删除/归档只在 verify 数据目录实例上做。

- **列表与切换。** 点「会话」tab → `session-list-header` 可见；点第一个 `session-detail-card` → 对话流切换；记下其中一条独有消息文本 M1；点第二个会话行 → M1 不可见（隔离）；切回 → M1 重新可见。
- **归档。** hover 目标行 → `session-archive-btn` 可点（generating 时 disabled）→ 点击 → `sidebar-archive-count-badge` 出现且计数 +1，该行消失。
- **归档视图与恢复。** 点 `sidebar-archive-entry-btn` → `archive-list-view` 可见 → 点 `archive-row-<sessionId>` → `archive-summary-view` 可见（`archive-archived-pill` + `archive-restore-button`）→ 点恢复 → 回活跃列表。
- **右键菜单。** 行 `session-detail-card` 右键（`click({ button: 'right' })`）→ `session-context-menu` 可见 → 点 `session-mark-done-item` → 行样式/标记变化；`session-stop-item` 首点出确认文案、再点才执行（两段确认）。
- **副作用取证。** 归档后 `ls <dataDir>/ext-sessions/`（活跃树变化）+ 归档存储位置对照；恢复后对照回来。
- **Proof。** 截图（列表 / 归档视图 / 摘要）+ 切换隔离的断言输出 + 目录树前后对照。

## Gotchas

- 切换 session 后会话级状态（命令清单等）靠主动拉取，广播可能早于订阅——断言前多等一次数据到位，不假设即时。
- 归档按钮 `disabled` 当该会话 generating 中——验收归档先等流式结束或先停。
- 右键菜单项的两段确认（停止 / 强制退出）：只点一次不算执行，断言要等到二段确认出现再点。
- 会话行的操作按钮是 hover 才出现的（`session-archive-btn` 在 `SessionItemActions`）：驱动先 hover 行再点按钮。
- 「彻底删除」在归档摘要视图（本剧本写作时以 `archive-*` 家族锚点驱动；若 UI 改版以 `e2e/session-archive.spec.ts` 与组件实装为准，剧本漂移按 maintain 流程修）。
