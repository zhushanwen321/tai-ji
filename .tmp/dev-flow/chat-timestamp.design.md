# 对话流时间戳展示（chat-flow-timestamp）精简设计

> 审查豁免记录：用户 2026-09-13 明示「不需要复杂设计」——阶段 0 对抗式审查以「demo 交互迭代（/tmp/chat-timestamp-demo.html 五方案对比）+ 用户拍板方案 F」替代，正式三审豁免。设计内容源 = 会话调研结论 + demo + 用户拍板。

## 1 背景/目标

- 现状：pi entry 持久化 **UTC ISO timestamp**（`PiEntryBase.timestamp`）；wire `Message.timestamp` 必填（epoch ms，reducer `toMs()` 派生）；`ToolCall.startTime` 必填 + `endTime?` **live 有、reload 缺**。UI 现仅 TurnMeta 显示 turn 耗时（`useTurnElapsed`），无绝对时刻展示；tool 展开态 meta 有耗时但 reload 后消失（endTime 缺失，live≠reload 漂移点）。
- 目标（用户拍板 demo 方案 F）：
  1. 块行尾常驻「耗时 · 时刻」（tool 块两者都显；text/thinking/user 只显时刻）
  2. TurnMeta 在「已工作 Xs」后接 turn 首末时刻区间 `· HH:MM:SS → HH:MM:SS`
  3. 历史 reload 与 live 形态一致（live≡reload 红线）
- Out-of-scope：demo 方案 A/B/D/E 其他形态；per-part 块级精确时间（pi 无此数据，text/thinking 用所属 message 时刻近似）；时区切换设置（恒本地时区）；subagent panel 内部对话流；移动端。

## 2 终态/机制

1. **core endTime 回填**：`packages/core/src/domain/chat/apply-entry-convert.ts` 的 `computeToolCallFill` 增加返回 `endTime`（来源 = toolResult `body.timestamp`，缺失不填）→ 调用方（apply-entry.ts 回填 / live `commitToolResultMessage` 同函数）合入 toolCall。live 的 `tool_call_end` overlay `Date.now()` endTime（registry.ts）保持作即时反馈，`message_end` 回填以权威值覆盖——两通路终点同源，等价性测试守卫。
   **U3 补全（Gate A 实测）**：R2-S1 幂等去重命中分支放行 endTime 单字段覆盖（last-wins）——首条帧（tool_call_end 重构）body.timestamp 是客户端时钟，后到 message_end 才携带 pi 权威值；其余字段维持首条 wins、copy-on-write 保持。守卫双层：core E8（非对称时钟 fixture）+ runtime relay-live-reload（生产双发帧形态）。
2. **formatClock**：`packages/ui/src/features/chat/format-utils.ts` 新增 `formatClock(ms: number): string` → 本地时区 `HH:MM:SS`（`new Date(ms)` + 本地 getter 补零）。**禁止切 ISO 字符串**（pi 落盘 UTC，裸切差 8 小时——2026-09-13 用户实测确认）。
3. **TurnMeta 区间**：`useTurnElapsed` 增加首末时刻输出（firstTs/lastTs 已算好）；`TurnMeta.vue` 在 elapsed 后渲染 `<span class="tm-range">· HH:MM:SS → HH:MM:SS</span>`（完成态定格）/ `· HH:MM:SS →（进行中）`（live，结束侧留空）。样式：mono text-2xs neutral-dim（demo 同款）。文案 key 走 i18n（zh-CN/en-US `panel.ts`，复用或新增「进行中」）。
4. **Block 行尾列**：
   - `Block.vue` 增 prop `messageTimestamp?: number`（所属 assistant message 时刻）；`Turn.vue` 经既有 `assistantById.get(fb.assistantId)?.timestamp` 传入；v-memo deps 补该 primitive。
   - tool 块 header 尾部 `ml-auto` 右槽：`formatDuration(startTime, endTime)`（end>start 才显示；running 态 accent）+ `·` + `formatClock(startTime)`。
   - text/thinking 块行尾只显 `formatClock(messageTimestamp)`。
   - `useToolMeta` 展开态耗时项移除（上提 header 常驻，去重）。
   - `UserBubble.vue` 增 timestamp 显示（气泡左侧行尾槽，`turn.user.timestamp`）。
5. **数据缺口语义**：endTime 缺失（running / end_not_received / 旧数据）只显时刻不显耗时；messageTimestamp 缺失（异常降级）整槽不渲染。

## 3 验收场景表

| # | 场景 | 通过标准（真实流程/机器可判） |
|---|------|------------------------------|
| A1 | 完成 turn TurnMeta 区间 | DOM 含 `已工作`/`worked` + `HH:MM:SS → HH:MM:SS` 区间文本 |
| A2 | live turn 区间 | streaming 中显示 `→（进行中）`；结束后定格为末 assistant 时刻 |
| A3 | tool 块行尾 | 完成块 `X.Xs · HH:MM:SS`；running 块耗时随时间增长、时刻=startTime |
| A4 | text/thinking/user 行尾 | 显示所属 message / turn.user 的本地时刻 |
| A5 | 历史 reload 耗时持久 | 重开 session 后 tool 块耗时仍在（endTime 回填），live/reload 数值同源 |
| A6 | 时区正确 | formatClock 输出 = 本地时区时刻（单测用本地 Date getter 断言，禁硬编码时区串） |
| A7 | live≡reload | `apply-entry-equivalence` 套件全绿 |

## 4 下一层拆分

- **U1 core endTime 回填**：apply-entry-convert + 调用点 + core 测试
- **U2 UI 展示层**：format-utils / TurnMeta / useTurnElapsed / Block / useToolMeta / UserBubble / Turn.vue / i18n + ui 测试（依赖 U1 的 A5；编译无硬依赖，串行执行）
