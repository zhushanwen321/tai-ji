# composer skill 触发域：chip 后换行新行行首 `/`（已裁决收编，2026-10-03 关闭）

来源：2026-10-03 chip spacer（ZWSP）触发死区修复（composer-multi-skill-injection D1 边界收编 `(?:[^\S\n]|\u200B)`）时的边界盘点。

## 状态：已收编（用户裁决 2026-10-03，随本主题 commit 实装）

裁决内容：**有 chip 时，行首/换行后行首 `/` 也归 skill 域**（命令域此刻本就被 hasChip 门整体抑制，两域不产生重叠），使「chip 后换行再续 skill」与同行续敲一样可达，多 skill 连续注入不再有换行断点。

## 实装落点

- `packages/dom-core/src/composer/input/input-dom.ts`：新增 `SKILL_TRIGGER_PATTERN_WITH_LINE_START = /(?:[^\S\n]|\u200B|^|\n)\/(\S*)$/` + `skillTriggerPatternFor(el)` 单点选择（按 `CHIP_PRESENCE_SELECTOR` 判定 chip 存在性）+ 共享选择器常量 `CHIP_PRESENCE_SELECTOR`。
- `contenteditable.ts`：`detectSlashTrigger` 的 hasChip 抑制门与 `skillTriggerPatternFor` 同用 `CHIP_PRESENCE_SELECTOR`（判定单一源，杜绝「命令域已抑制而 skill 域未收编」的重叠/死区）；`clearSkillQueryText` 改用 `skillTriggerPatternFor(getEl())`（能触发就能清）。
- `remove-active-token.ts`：skill 域约束源放宽为 `(?:[^\S\n]|\u200B|^|\n)\/`（清理侧同宽；误删面受「全 el 恰一处命中」唯一性门 + 右边界 `(?!\S)` 约束，多命中/0 命中一律 no-op 安全侧）。
- 测试锁：`skill-trigger.test.ts` 新增「chip 感知行首收编」组（纯 detect 有/无 chip 对照 + 编排只亮 skill 路 + clear 正反向）；`remove-active-token.test.ts` 新增 node 起始 token 删除用例。
- 设计文档：`docs/architecture/composer-multi-skill-injection.md` D1 + 变更历史（2026-10-03 条）。

## 已知代价（已接受）

`^` 为 per-node 语义（detect 与清理两侧均逐 text node 匹配）：理论上「光标落在文档中部某 text node 偏移 0 且该处非视觉行首」时可被 `^` 命中而短暂触发 skill 浮层。composer 的实际 DOM 形态（纯文本 + chip + `<br>`）下视觉行首与 node 起始基本重合，且 query 合法性过滤（含空串合法、非法字符即关闭）把误弹收敛为极小浮层 + 输入即收；清理侧多命中即 no-op 不会误删。后代样式 span（富文本粘贴）属未覆盖形态，出现真实反馈时再评估「按 Range 可视行首 + 选区上下文」的精确化路径。
