# demo 100% 复刻波残差与待裁决项

状态：待裁决（2026-10-10 全托管复刻波收尾登记；复刻 = Open Design 项目 f7a69696 的 taiji-vue-app 高保真 demo 为唯一视觉权威，本波 24+ 笔提交落地面为全应用）。登记来源：ui-replica 会话（令牌地基 Wave1 + M0-M9 十模块复刻 + 视觉对比修复三轮 + review-fix-loop）。

## 待用户裁决

1. **朱印主题行内代码对比度 3.92:1（已关闭，2026-10-10 用户裁决「demo 适配实际可读性标准」）**：3.92:1 是旧公式（字色 = code-c 本色）的遗留值；demo 与 real 均已演进到 R4.1 公式（字色 = neutral-fg 85% 混 code-c 15%），六主题在该公式下全部 ≥4.5:1（WCAG AA 正文线）。contrast 单测统一线由 4:1 提升至 4.5:1 实测全绿，差异化下限与 3.9 豁免废除——无需改任何色值。
2. **M8 扩展宿主面（StatusBar/L2TabBar/CompanionBand）**：demo 产品页无此面（HostFace 为存档页）。2026-10-10 真机核实渲染条件：StatusBar 由 pi 扩展调用 `setStatus` API（status-set 事件链）贡献条目，当前全仓零调用方 → 设计内零 DOM（PanelContainer 挂载位 = 主面板底部 26px 横带，见该文件 249 行）；demo 亦无此面对照。已顺手清掉 X1 登记的四死类（StatusBar/Card elevated 头/TabBar 激活项/FindBar 的 `bg-elevated` → `bg-bg-elevated`，模块地图 X1 全部关闭）。待有扩展真实消费或 demo 权威后单开波次。
4. **指标槽密度档位登记**：composer 底栏「三步聚合」密度现行档位 = fit 0 平铺四 chip（容量/TTFT/速度/缓存纯文本触发器）；fit 1 起指标聚合为单图标聚合按钮（hover 弹聚合页四卡，右簇先压）；fit 2 左簇聚合、fit 3 模型+思考聚合；容量顶缘细条（>80% 渲染）保留。口径 = composer-density.ts 状态机与 demo workbench.css 密度段（B1 裁决）双向一致。
5. **会话右键菜单信息架构差异（已裁决落地，2026-10-10 用户十项裁决 #4）**：悬停 ghost 钮收敛为 3 个（重命名/删除/归入项目），「标记完成」「引用到输入区」迁右键菜单（SessionItemContextMenu，Portal 恒渲染），demo 侧同构落地（.si-acts 3 钮 + 菜单裁剪为归档/导出 + 移动到项目）。**残留缺口：导出 JSONL**——real 任何入口均无该功能（demo 有 mock 项），需新增 JSONL 导出数据通道，待立项。
6. **R6.2 项目分组结构差距（用户裁决 2026-10-10：demo 侧还在设计，real 先空着）**：spec R6.2 已升级「方案 A 锚定分组」且 demo 已实现，但方案仍在设计迭代中——real 复刻等设计稳定后单开波次。此前登记的五项差距与候选波次范围仍有效（见 git 历史），复刻口径以 demo 设计终态为准。
7. **composer 指标聚合页布局差异（已关闭，2026-10-10 双重裁决）**：composer-bar-spec（demo 侧专项 spec，taiji-composer-bar-spec.md）3.2 明确「real 为 300px 宽聚合页把容量/TTFT/速度/缓存四张完整卡纵向拼装，信息不降级」——四卡形态获 spec 认可；用户本轮裁决「先空着」一致。该 spec 另产生 real 侧新需求 B1（宽度退化次序翻转：右簇指标先压、左簇后压）已单开实施。
10. **⌘K 搜索弹层输入聚焦焦点环（已裁决落地，2026-10-10 用户裁决 #8「输入面无缝」）**：SearchModal 输入补 focus-visible:outline-none（与 shadow-none/ring-0 三通道同压，光标即反馈）；spec R1.3 豁免面不扩充（搜索弹窗不豁免）。
11. **悬停详情卡 meta 行消息数段（缺数据通道，待立项）**：demo 悬停详情卡末行 = 「时间 · 消息数」两段（Sidebar.vue `cardSess.upd · cardSess.msgs`），real 末行仅相对时间——SessionSummary 无消息数字段，按「零新数据通道」约束未补（SessionItem.vue 注释在案）。待 SessionSummary 消息计数数据通道立项后对齐。

## 已裁决/登记即关闭

- **主题 label 名实漂移（已关闭：取「改 label 文案」选项）**：demo 玄主题行文案实为「太极 · 玄（暗 · 青玉 · 默认）」（原登记「demo 亦沿用旧名」前提有误）。`useTaijiThemes.ts` 玄主题 label 与头注释的色相描述 = 青玉，与 swatch 首格 `#7fb89c` 名实一致；appearance-page 单测断言同步。其余五主题 label（依稀蓝相/宣纸暖相/宣纸墨黑/宣纸花青/宣纸朱砂）与 DESIGN.md「阴 · 暗色族 / 阳 · 亮色族」描述一致，不在漂移面。
- **导航计数徽标保留**：demo 设置导航无徽标，real 保留（功能性信息），形态已按 demo .bdg 对齐。
- **外观设置行距差 8.6%**：根因 = html font-size 14px 全局 rem 缩放 + line-height 1.5/1.55，属全局基建；单点补丁破坏字号缩放一致性，不修。
- **底抽屉默认高 35% vs demo 280px@900≈31%**：real 高度为持久化用户值（含显示期 clamp），默认值差异不构成回归，维持。
- **markdown 表格网格 / 底抽屉 tab 描边**：像素取证证伪（1x 缩略截图伪影），代码已与 demo 逐值一致。
- **裸 border 灰白线（系统性）**：根修 = shared preset `borderColor.DEFAULT = var(--border)`，15 处消费点随之修正。
- **bg-card / text-muted / text-fg 失效类名**：preset 无映射的死类。本波改动面内已清零（含 ProviderPage 包裹 GroupCard 时顺带核实的 ScopedModelSection bg-card）；ui 包 settings 域其余文件仍有残留（W2 报告登记 5 处已顺手清零，ModelListSection/ScopedModelSection 等原语层待 ui 包波次清扫）。
- **侧栏三件套逐值对齐（2026-10-10 用户反馈驱动）**：会话行（字重 `--fw-mid` 600 替代 font-semibold 700；选中态 = demo `.si.on` Tier B 无底无框仅文字提亮，覆盖 2026-10-06 accent 底+竖条形态）、hover 详情卡（demo `.sess-pop`：mouseenter 立即开替代 700ms 延迟、行首 13px 图标 + mono 12px 值、末行时间 meta、定位/120ms `--duration-fast --ease-out` 对齐 openCard 公式）、footer 三钮（**32px `.tbtn`**——`.app` 作用域 `--hb-chrome-btn` 继承值、fallback 24 永不生效，2026-10-10 聚合员勘误 + 15px 图标 + stroke 1.6）、快捷面板（chip 12px、头 11px、`--sel-bg/--sel-edge` Tier A 选中 token 新增、左对齐 bottom 锚 8px、hover 开 + 260ms 延迟关、主题序对齐 demo THEME_PRESETS）。连带发现并根修 **PopoverContent 封装 fallthrough 断链**：封装模板单根 = PopoverPortal(Teleport)，消费方传的 data-testid/事件监听被 Vue 在 Teleport 边界静默丢弃（ImportSessionDialog 的 import-dir-menu 同类隐患一并治愈）——`inheritAttrs:false` + `$attrs` 显式转发到内部 reka PopoverContent；preset boxShadow 补第三档 `3: var(--shadow-3)`。面板 testid 丢失曾致真机排查大面积假阴性（面板实际正常渲染），排查时以 reka 原生 `id^="reka-popover-content-"` 为准。
- **capbar 常态渲染 vs spec R2.3（已修复对齐，review-fix-loop 第 1 轮 MF-1-40 落地）**：渲染门控已按 spec R2.3 / demo ComposerBar（`v-else-if contextPct>80`）对齐——≤80% 不渲染（ComposerCapacityBar.vue 门控 `hasPercent && percent > CAPACITY_BAR_WARN_THRESHOLD`），capacityBarClass 无 accent 常态档（仅 >80 warn / >95 danger 两档，context-usage-display.ts；与浮层卡内 usageBarClass 的 70/90 阈值差为在册有意差异）。spec 基线文档 taiji-ui-requirements-spec.md 不在本仓，其 S3 行（capbar 冲突）同步标记已解决，待主会话在 spec 侧同步。
- **文件树长文件名展示契约互斥（已关闭，2026-10-10 用户裁决 #7「不做横向滚动，用省略号+悬停展示」；demo 同日 20:00 改向同口径）**：real 宽度模型从 max-content 整树横滚切换为 100% 容器宽（FileView itemProps），FileTreeRow 名称段 = ellipsis 截断 + title 悬停展示全名，与 demo `.fname` 现行契约同构（demo 早期 `.fname-scroll/.fname-roll` marquee 方案已废弃、源树无该类定义，real 侧 marquee 双层结构随改向卸载）。旧互斥登记与「待裁决期间禁止补 truncate」约束作废。
- **spec R8.3 footer 钮尺寸文本与 demo 权威矛盾（已关闭，spec v1.1 已含 R8.3 32px 勘误）**：demo 权威 = workbench.css `.app{--hb-chrome-btn:32px}`，`.tbtn{width:var(--hb-chrome-btn,24px)}` 的 fallback 24 因变量恒有值永不生效；real 侧按 32px 对齐已随本波 MF-1-4 落地，spec 文本修订（R8.3 尺寸 24px→32px）已由主会话在 spec 侧完成。R6.2 状态列 real 未复刻标注已随第 6 条登记。

## 关联

- [e2e-visual-shell-baseline-stale.md](e2e-visual-shell-baseline-stale.md)：本波后 shell/composer 两张基线再次红（有意变更），push 后 CI 通道重录。
- [mobile-token-mirror-divergence.md](mobile-token-mirror-divergence.md)：Wave1 已同步 accent 族到 mobile 镜像（parity 断言强制），bg/neutral 等仍分叉如前述登记。
