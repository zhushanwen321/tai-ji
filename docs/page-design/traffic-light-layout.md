# 窗口顶部 traffic light 布局（v3 shell 拓扑 + 刻意调整形态，布局 SSOT）

> 从 AGENTS.md 前端编码规范第 11 条外移（2026-08-17）。本文件是窗口顶部布局数值的唯一载体——新增或修改任何窗口顶部区域 UI 时，先对照本文数值。

v3 重建采用 zcode-demo 拓扑：base 平铺全屏 → sidebar 透明融合 → main 是唯一 float-panel 浮起。traffic light 靠 **aside-region 顶部留白**兼容，而非旧版 padding-left 避让。**2026-08 二次裁决：本拓扑是刻意调整，不遵循 v6 demo**（PanelHeader 调小至 22px 与 trafficlight 行共线对齐、main-panel 与窗口边框间距收紧至 4px、折叠态 chrome 落入 header 等，出自 8c62f64bc/0251b6d40/860ee6007 等 commit）。此前一次裁决曾按「以 v6 demo 为准」回填 v6 拓扑（38px header / trafficLight {16,26} / p-3 / 52px 安全区），后经用户确认刻意调整被误改，已整体恢复。

## 数值清单

- AppShell `p-1`(4px) 四周统一：上下左右各 4px（紧凑但有呼吸，对称）。注意：左右 4 使 aside 左缘 x=4，与红黄绿 x=8 有 4px 差（红黄绿保持原生位置不动，用户明确不移动 trafficLightPosition）；折叠态 `!gap-0`（aside 归零，padding 保持 p-1 四周 4px，与展开态一致）
- `.aside-region` 恒定 `padding-top: 44px`(pt-11)（安全区 + 拉开 trafficlight 行与 LOGO 行间距），**三平台统一，全屏也保留**（mac 全屏 hover 时系统下拉覆盖层会落进这块留白）。AppShell py-1 使 aside 顶在窗口 y=4，红黄绿 y=8~20，安全区让出，与 trafficlight 行（nav 按钮 bottom y27）视觉间距约 12px
- mac 红黄绿位置由主进程 `titleBarStyle:'hidden'` + `trafficLightPosition:{x:8,y:8}` 放到 macOS 原生左上角（**不用 hiddenInset**——inset 模式强制水平内缩，`trafficLightPosition.x` 被系统忽略）；win/linux 自绘圆点 `left:0 top:[4px]`（TrafficLight.vue 挂载于 AsideRegion 内，aside 顶在窗口 y=4，故 top-4 = 窗口 y8，与 mac 同位）。圆点 12px，顶理论 y=8 / **实测中线 y≈15.75**（macOS 渲染亚像素偏置，比理论 y14 低 ~2pt）/ 右缘 x=60
- app-nav-controls（收起侧栏/←/→）浮在 AppShell 层（aside 外，避免折叠态 overflow-hidden 裁剪），**非折叠态** `left:72px top:5px`（按钮中线 y=5+11=16，对齐红黄绿**实测**中线 ~15.75；红黄绿右缘 60 + 12 呼吸），全屏 `left:8px`（320ms 平移与 traffic-light opacity 同步）。**PanelHeader `h-[22px]` 与 trafficlight 行共线对齐**：main-panel 顶=AppShell p-1(4)+border(1)=y5，h-22 → header bottom y27 = nav 按钮 bottom，内容中线 y16 ≈ 红黄绿实测中线 y15.75（三者顶/底/中线全对齐）。右侧 drawer/git 按钮 `size-[22px]` 适配 22 高 header
- **折叠态** chrome 迁入 P1 PanelHeader 内（header `pl-[88px]` 让位红黄绿右缘 60），chrome 按钮在 header 中线（header h-22 中线 y16 = 红黄绿中线，无高度差）；AppShell 折叠态 `!gap-0`（强制覆盖 gap-3，padding 保持 p-1）
- 全屏两态：非全屏（traffic light opacity 1，按钮 left:72px）/ 全屏（opacity 0，按钮左移 left:8px）。**无第三态**，mac 全屏 hover 红黄绿由系统提供，应用不渲染。全屏态 TrafficLight 圆点 `opacity-0 pointer-events-none` 成对（review MF-1：隐形圆点仍可命中会劫持 header chrome 点击）
- win/linux 走 mimic_mac：自绘彩色圆点放左侧模拟 mac，三平台左上视觉统一
- 唤回侧栏：⌘B + header chrome 按钮（**rail-restore 左缘细条已移除**）

## 相关

- 读 [v6 shell spec](v6-spec-shell.html) 了解设计稿差异（v6 demo/spec 的 38px/16,26/52px 拓扑不适用本实现，属刻意偏离）
- 设计决策记录：[ADR 0017（档案摘要）](../adr/archive-digest.md#adr-0017)（旧版 padding-left 方案，**已 Superseded**，原文 git 可追溯）；8c62f64bc/0251b6d40/860ee6007（刻意调整序列，现版形态来源）
