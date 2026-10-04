# system-prompt-trace 前瞻：改提示词能力引入时留痕须迁 context_with_system 锚点

状态：前瞻登记，无现行动作（pi1-disposition-chat-flow 设计 D15「登记（不做）」/ 三域扫描，2026-10-04 登记）。

- 现状：system-prompt-trace 扩展订阅 session_start / session_before_switch / turn_start 三事件留痕系统提示词模式与回落事实（`extensions/taiji/system-prompt-trace/src/index.ts:56-73`）。pi 1.0 新事件 context_with_system 是「实际发送提示词」的唯一权威锚点，现役留痕机制未消费该事件。
- 影响面：现状零影响——改写实际发送提示词的上下文链能力尚不存在；一旦引入（扩展/宿主侧改提示词的通路），现役留痕与实际发送内容脱节，trace 面板失去权威性。
- 恢复通道：该类能力立项时，留痕机制同批迁移到 context_with_system 锚点（迁移纳入该设计范围，不单独立项）。
- 重审触发：任何「修改实际发送提示词」能力的设计启动时——设计期即核对留痕迁移义务。
