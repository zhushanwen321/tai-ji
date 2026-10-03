# composer skill 触发域：chip 后换行新行行首 `/` 死区（待裁决）

来源：2026-10-03 chip spacer（ZWSP）触发死区修复（composer-multi-skill-injection D1 边界收编 `(?:[^\S\n]|\u200B)`）时的边界盘点。同行主链路（Tab 确认后直接续敲 `/` → skill 浮层）已修复并锁定（`packages/dom-core/src/composer/input/skill-trigger.test.ts` chip spacer 边界组）；本条登记的是同族残余。

## 现状

已有任意 chip（`.slash-chip` / `.mention-chip`）时，按 Enter 换行后在新行行首敲 `/`：

- 命令域：`detectSlashTrigger` 的 hasChip 门整体抑制（`contenteditable.ts`，chip 存在即 null，命令 chip 单实例语义）→ null；
- skill 域：ZWSP 边界在上一 text node，换行后新行行首 `/` 的 anchor node 前缀无边界字符，`[^\S\n]`/`\u200B` 均不命中（换行边界刻意让位命令域）→ null。

两域皆 null → 浮层不弹，用户输入的 `/xxx` 停留为明文。影响面：多行草稿 + chip 混排场景的「第二条 skill」，低频；同行多 skill 主链路不受影响。

## 裁决点

是否收编「存在 chip 时，换行后新行行首 `/` 也归 skill 域」（命令域已被 hasChip 抑制，收编不产生两域重叠）。收编落点：`detectSkillTriggerFromEl` 加 chip 感知的 `^`/`\n` 边界分支 + `clearSkillQueryText`（pattern 同源 SKILL_TRIGGER_PATTERN，需同批扩展）+ remove-active-token skill 域约束源语义核对（per-node `^` 与 el 行首的差异需评估误删面）。不收编则维持死区现状（用户可改用空格后续敲）。
