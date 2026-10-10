# 朱印主题行内 code 对比度锚定线登记（已失效）

状态：已失效（无需裁决）——`--md-code-fg` 公式对齐 demo R4 弱化终态（`color-mix(in oklch, var(--neutral-fg) 85%, var(--code-c))`，`packages/renderer/src/style.css`）后，朱印实测对比 10.50:1，六主题恢复统一 ≥4:1 断言线（`contrast-tokens.test.ts` 的 `CODE_CONTRAST_MIN` 全表为 4）。

## 登记内容与失效原因

原裁决对象：行内 code 对比下限单测对朱印（亮）单独锚定 3.9（其余五主题 ≥4:1）。原因：旧公式下字色 = `--code-c` 本色，朱印 demo 权威颜料 `#9a6b40` 于 7% 叠亮色族 `--surface` 的 sRGB 合成实测 3.92:1，达不到统一 4:1 线；demo 是唯一视觉权威、不改值，故朱印单独锚定 3.9 保真，裁决权在用户。

失效原因：R4 公式落地后字色不再是 code-c 本色（主前景 85% 混合，对比大幅升高），六主题（含朱印）全部 ≥10:1，3.9 锚定线失去对象，断言回归统一 4:1，无需用户裁决。

## 关联位置

- 断言表与锚定注释：`packages/renderer/src/__tests__/contrast-tokens.test.ts`（文件头 + `CODE_CONTRAST_MIN` 表）
- 颜料与公式定义：`packages/renderer/src/style.css`（`--md-code-fg` 公式 + 朱印块 `--code-c`）
- `docs/todo/ui-replica-demo-fidelity.md`「待用户裁决」清单中与本登记同指一项的条目：以本文件状态行为准，防双登记漂移
- 若后续出现「调深朱印 `--code-c` 颜料」类新裁决需求，另立登记，不在本文件复活
