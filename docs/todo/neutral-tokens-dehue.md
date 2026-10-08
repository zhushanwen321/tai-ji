# neutral 五档令牌去色相偏（D4 移出项，品牌一致性清洁项）

状态：部分解决——桌面侧已由 ui-optimize-unified 决策 2 落地（五档重校档距 + 纯中性，非本文件原候选值：本文件原「保持亮度仅去色相」方案被该决策的「重校档距 + 纯中性」取代，桌面终态见 `packages/renderer/src/style.css` :root）；mobile 侧残留旧值待裁决，登记见 [mobile-token-mirror-divergence.md](mobile-token-mirror-divergence.md)。登记来源：ui-signal-density 设计 D4「本轮移出本次范围」

## 背景

玄主题 neutral 五档实测带同向蓝紫偏（OKLCh H 全部 285.9°–286.3°，C 0.0054–0.0100）。中性化方案 = 除去色相偏、保持各自 OKLCh 亮度不变：

| 令牌 | 现值 | 中性化候选 |
|---|---|---|
| `--neutral-fg` | `#dedee2` | `#dedede`（C 0.0054 → 0） |
| `--neutral-mid` | `#96969c` | `#979797` |
| `--neutral-dim` | `#74747a` | `#757575` |
| `--neutral-faint` | `#46464c` | `#474747` |
| `--neutral-ico` | `#86868c` | `#878787` |

> 注：桌面侧终态已由 ui-optimize-unified 决策 2 落地（重校档距 + 纯中性，**非本表候选值**），现行值见 `packages/renderer/src/style.css` :root neutral 段；本表为历史候选记录。mobile 镜像残留见 [mobile-token-mirror-divergence.md](mobile-token-mirror-divergence.md)。

## 移出理由（设计原文口径）

- 视觉差在实测彩度 0.005–0.010 的量级上，接近感知阈。
- 「层级靠颜色」这个错误手段的纠正已由行类型视觉分工（字号 × 明度 × 有无容器）独立完成，不需要 5 个 neutral 值一起换。
- 代价 = 5 个全局令牌 + 一份像素重录面，收益答不出「不做会怎样」。

## 重开条件

与下一次令牌族改动合并（共用同一次像素重录）时顺带执行；或品牌一致性审查点名灰阶纯度时单独立项。执行时注意：`packages/mobile-renderer/src/styles/tokens.css` 是 renderer `style.css` tokens 段的镜像副本，改 neutral 五档须同步两处。
