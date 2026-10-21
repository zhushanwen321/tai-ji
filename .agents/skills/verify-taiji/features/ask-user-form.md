# 统一提问表单（FormOverlay）

agent 遇到无法自行消解的歧义时，经 ask-user/scheduler/plan 共用的统一浮层向用户提问：多题 tab、每题选项（label + description）、自动附加 Other 自由输入。这是 agent↔用户交互闭环的唯一通道——挂了 agent 提问无人应答。

## Sub-features

- `au-trigger` agent 调 `ask_user` 工具 → `form-overlay` 浮层出现，回合停在工具执行中等待用户。
- `au-question` 单题形态：`form-question-text` 显示问题文本，选项可点。
- `au-multi` 多题形态：`form-tab-<i>` 逐题 tab + 已答标记 `form-tab-answered`，`form-next` 翻题。
- `au-submit` 全部作答后 `form-submit` 提交 → 浮层关闭，agent 收到选择继续回合。
- `au-cancel` `form-cancel` 取消 → 浮层关闭，agent 收到取消。
- `au-other` 选项自带 Other 自由输入（schema 禁止 agent 自带 Other，UI 自动附加）。

## How to get to it (user POV)

- 无手动入口：由 agent 在对话中触发。用户看到浮层 → 点选项（或填 Other）→ 下一题 / 提交。

## Driving it with browser-automation (CDP)

Preconditions:

- doctor 全绿；**faux 装配实例**（触发 = faux 脚本编排 `ask_user` 工具调用）。
- faux 响应脚本（三 step：提问 → 收到选择后的确认文本；工具执行结果回灌后 pi 走下一轮）：

```json
[
  { "toolCalls": [{ "name": "ask_user", "args": { "questions": [
      { "header": "数据库", "question": "选哪个数据库？", "context": "需要 ACID 与 JSON 列。",
        "options": [ { "label": "SQLite", "description": "零运维，嵌入式" }, { "label": "Postgres", "description": "成熟，强一致" } ] },
      { "header": "区域", "question": "部署在哪个区域？",
        "options": [ { "label": "us-east-1", "description": "美东" } ] }
  ] } }], "stopReason": "toolUse" },
  { "text": "已按你的选择继续。", "stopReason": "stop" }
]
```

- **触发。** 按 new-task 剧本建 session 首发提交（脚本第一 step 即提问）→ `form-overlay` 可见、`form-question-text` 含问题文本。
- **单题作答。** 点一个选项 label → 选中态；多题时点 `form-next` → `form-tab-0` 出现 `form-tab-answered` 标记、切到下一题。
- **Other。** 在 Other 输入框填自由文本 → 以 Other 为该题答案。
- **提交。** 末题作答后 `form-submit` 可点 → 点击 → 浮层关闭；faux 第二 step 的确认文本出现在对话流（agent 确实收到选择）。
- **取消路径（新回合）。** 再起一轮提问，点 `form-cancel` → 浮层关闭、回合收到取消继续/结束。
- **副作用取证。** `<dataDir>/ext-sessions/<sessionId>/logs/pi-<date>.jsonl` 里有 ask_user 工具调用与结果记录。
- **Proof。** 截图（浮层 / 多题 tab / 提交后对话流）+ DOM 断言输出 + pi jsonl grep 行。

## Gotchas

- options 的每一项必须是 `{ "label", "description" }` 对象（字符串数组会被扩展层友好拦截）；questions 多于 1 个时每题要带 `header`；不要自带「Other」选项（UI 自动附加）。
- 浮层是阻塞式 UI：提问期间回合停在工具执行中，`form-overlay` 一直在场；断言「回合继续」的信号 = 浮层消失 + 下一 step 文本到达。
- 工具调用期间的 turn 呈工具运行态：不要把「没有文本流」误判为挂死。
- scheduler / plan 的表单与 ask-user 同壳（FormOverlay 家族），驱动锚点同族；要验它们的特有字段（如日期时间选择）再读对应组件。
