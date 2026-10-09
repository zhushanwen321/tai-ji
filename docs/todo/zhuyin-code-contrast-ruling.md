# 朱印主题行内 code 对比度锚定线（3.9 vs 4.0）待用户裁决

状态：待用户裁决（现行落码形态 = 朱印锚定 3.9、其余五主题 ≥4:1；本文件是该裁决的登记处，裁决后按所选方向落终态并关闭）

## 待裁决项

行内 code 对比下限单测（`packages/renderer/src/__tests__/contrast-tokens.test.ts` 的 `CODE_CONTRAST_MIN` 表）对六主题的断言线：玄 / 黛蓝 / 暖墨 / 皓 / 青墨均为 ≥4:1，唯独朱印（亮）锚定 3.9。偏离原因：朱印 demo 权威颜料 `--code-c: #9a6b40`（`packages/renderer/src/style.css` 朱印块；code 底 = code-c 7% 叠亮色族 `--surface` `#f7f6f3`）在同口径 sRGB 合成下实测对比 3.92:1（复算 3.9212:1，合成底 `#f0ece6`），达不到统一 4:1 线；demo 是唯一视觉权威、不改值，故朱印单独锚定 3.9 保真。

该豁免使朱印成为六主题中唯一低于 4:1 线的主题，属对比度防线阈值的取舍，裁决权在用户；测试断言值与注释均已指向本登记，裁决前维持现状不改。

## 裁决方向（二选一）

1. **接受 3.9 锚定线（现状转正）**：朱印维持 demo 值 `#9a6b40` 与 3.9 锚定下限，其余五主题维持 ≥4:1；裁决后本文件状态行落定案，测试注释去掉「待裁决」表述。
2. **放宽 demo 值**：朱印 `--code-c` 调深至同口径实测 ≥4:1（偏离 demo 权威颜料——视觉权威让位于可读性下限的裁决），六主题统一 ≥4:1；单测 `CODE_CONTRAST_MIN.zhuyin` 改回 4，注释与本文件同步关闭。

## 关联位置

- 断言表与锚定注释：`packages/renderer/src/__tests__/contrast-tokens.test.ts`（文件头 + `CODE_CONTRAST_MIN` 表）
- 颜料定义：`packages/renderer/src/style.css` 朱印块 `--code-c`
- 设计权威同值记载：`docs/DESIGN.md` §4 六主题 `--code-c` 挂值表（朱印行 3.92:1）
- `docs/todo/ui-replica-demo-fidelity.md`「待用户裁决」清单第 1 项与本登记同指一项：裁决与关闭以本文件为准，防双登记漂移
