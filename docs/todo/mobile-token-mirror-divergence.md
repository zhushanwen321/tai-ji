# mobile-renderer 令牌镜像副本与桌面 style.css 分叉待裁决

状态：待裁决（D5 终态同步 contested 裁决：不把 ui-optimize-unified 令牌终态扩张到 mobile 壳——该设计从未裁决 mobile 壳视觉，盲改无验收覆盖；但镜像同步契约已被桌面侧改值打破，须显式登记）。登记来源：ui-optimize-unified D5 终态同步（2026-10-08）

## 现状（2026-10-08 核实）

`packages/mobile-renderer/src/styles/tokens.css:20-22` 文件头自述「真值源仍是 renderer style.css……改动须同步两处」，但桌面侧 ui-optimize-unified 已完成五层分层改值 + 灰阶四档去蓝偏 + `--composer-bg`/`--bubble-bg` 退役，mobile 侧全部未跟随：

| 位置 | mobile 现值 | 桌面终态 |
|---|---|---|
| tokens.css:27 `--bg` | `#131316` | `#1e1e1e`（框架层提亮） |
| tokens.css:29 `--surface` | `#1f1f22`（亮于 bg 的旧方向） | `#101010`（内容层沉底） |
| tokens.css:38 `--bubble-bg` | `var(--surface-hover)`（已退役改指） | `--bg-elevated` |
| tokens.css:39/:188 `--composer-bg` | 残留（桌面已退役，全仓零消费方——死定义） | 已删除 |
| tokens.css:43-44 neutral fg/mid | `#dedee2`/`#96969c`（蓝偏旧值） | `#ececec`/`#8a8a8a`（纯中性四档） |
| tokens.css 全文件 | 无 `--md-code-*` 组 | `--md-code-bg/fg` 六主题各一对（决策 5） |
| main.ts:41-44 neutral 兜底值 | 同旧 | —（style.css 加载成功时不生效，但兜底失真） |

镜像校验单测 `mobile-token-mirror-parity.test.ts` 断言面仅 accent 族四组，neutral/bg/fw 不在断言面，故双绿不拦分叉。

## 裁决选项

1. **mobile 跟随本波终态**（一次性同步五层阶梯 + 四档灰阶 + `--md-code-*` 组 + 死定义清理）——收益：两壳观感一致、镜像契约恢复；代价：mobile 壳无像素验收轨，改值需真机核对。
2. **解除镜像声称**：mobile 壳独立演进，删除 tokens.css 头部镜像自述与 parity 单测的同步义务前提——收益：诚实反映现状；代价：两壳令牌永久分叉，后续每波桌面令牌改动都需单独裁决 mobile 是否跟随。

## 关联登记

- [neutral-tokens-dehue.md](neutral-tokens-dehue.md)（neutral 去蓝偏——桌面侧已由 ui-optimize-unified 决策 2 落地，mobile 侧残留旧值即本文件 :43-44 行）
- [mobile-token-mirror-e2e-map-scope-gap.md](mobile-token-mirror-e2e-map-scope-gap.md)（镜像范围口径既有登记）
