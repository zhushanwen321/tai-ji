# demo 100% 复刻波残差与待裁决项

状态：待裁决（2026-10-10 全托管复刻波收尾登记；复刻 = Open Design 项目 f7a69696 的 taiji-vue-app 高保真 demo 为唯一视觉权威，本波 24+ 笔提交落地面为全应用）。登记来源：ui-replica 会话（令牌地基 Wave1 + M0-M9 十模块复刻 + 视觉对比修复三轮 + review-fix-loop）。

## 待用户裁决

1. **朱印主题行内代码对比度 3.92:1**：demo 权威值朱印 `--code-c #9a6b40`（亮色 7% 叠底）实测 3.92:1，低于旧 ≥4:1 断言线；contrast 单测已按 demo 值锚定 3.9 下限 + hex 双锁。选项：接受 3.92:1 为该主题终态（现状）/ 放宽 demo 朱印 code-c。
2. **M8 扩展宿主面（StatusBar/L2TabBar/CompanionBand）**：demo 产品页无此面（HostFace 为存档页）。2026-10-10 真机核实渲染条件：StatusBar 由 pi 扩展调用 `setStatus` API（status-set 事件链）贡献条目，当前全仓零调用方 → 设计内零 DOM（PanelContainer 挂载位 = 主面板底部 26px 横带，见该文件 249 行）；demo 亦无此面对照。已顺手清掉 X1 登记的四死类（StatusBar/Card elevated 头/TabBar 激活项/FindBar 的 `bg-elevated` → `bg-bg-elevated`，模块地图 X1 全部关闭）。待有扩展真实消费或 demo 权威后单开波次。
4. **指标槽密度逆转登记**：本波按 demo 终态恢复了 fit 0/1 平铺四 chip（U11 曾按当期 demo 裁决退役平铺改全档聚合）；fit 2/3 聚合与容量顶缘细条保留。两期 demo 形态不同，以 2026-10-09 demo 终态为准。

## 已裁决/登记即关闭

- **主题 label 名实漂移（已关闭：取「改 label 文案」选项）**：demo 玄主题行文案实为「太极 · 玄（暗 · 青玉 · 默认）」（原登记「demo 亦沿用旧名」前提有误）。`useTaijiThemes.ts` 玄主题 label 与头注释的色相描述 = 青玉，与 swatch 首格 `#7fb89c` 名实一致；appearance-page 单测断言同步。其余五主题 label（依稀蓝相/宣纸暖相/宣纸墨黑/宣纸花青/宣纸朱砂）与 DESIGN.md「阴 · 暗色族 / 阳 · 亮色族」描述一致，不在漂移面。
- **导航计数徽标保留**：demo 设置导航无徽标，real 保留（功能性信息），形态已按 demo .bdg 对齐。
- **外观设置行距差 8.6%**：根因 = html font-size 14px 全局 rem 缩放 + line-height 1.5/1.55，属全局基建；单点补丁破坏字号缩放一致性，不修。
- **底抽屉默认高 35% vs demo 280px@900≈31%**：real 高度为持久化用户值（含显示期 clamp），默认值差异不构成回归，维持。
- **markdown 表格网格 / 底抽屉 tab 描边**：像素取证证伪（1x 缩略截图伪影），代码已与 demo 逐值一致。
- **裸 border 灰白线（系统性）**：根修 = shared preset `borderColor.DEFAULT = var(--border)`，15 处消费点随之修正。
- **bg-card / text-muted / text-fg 失效类名**：preset 无映射的死类。本波改动面内已清零（含 ProviderPage 包裹 GroupCard 时顺带核实的 ScopedModelSection bg-card）；ui 包 settings 域其余文件仍有残留（W2 报告登记 5 处已顺手清零，ModelListSection/ScopedModelSection 等原语层待 ui 包波次清扫）。

## 关联

- [e2e-visual-shell-baseline-stale.md](e2e-visual-shell-baseline-stale.md)：本波后 shell/composer 两张基线再次红（有意变更），push 后 CI 通道重录。
- [mobile-token-mirror-divergence.md](mobile-token-mirror-divergence.md)：Wave1 已同步 accent 族到 mobile 镜像（parity 断言强制），bg/neutral 等仍分叉如前述登记。
