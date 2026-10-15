# i18n key 使用面与定义面缺少机器对齐守卫

状态：待裁决（2026-10-15 登记，源自 problem-solve-canvas D3 GUI 真机验收）

## 现象

2026-10-15 GUI 验收发现节点详情面板渲染出 i18n key 原文（`panel.canvas.op.editAction` 等 7 个 canvas 域 key + `settings.preset.collapse/expand` 2 个，共 9 个）。根因：词条定义在 locale 外层子树（运行时 key = `panel.canvas.editAction`），组件调用却带 `panel.canvas.op.` 前缀——定义面与使用面错位，vue-i18n 取不到值即渲染 key 本身。

## 守卫缺口

现有 `.githooks/check_i18n_locale_sync.py` + `__tests__/i18n/locale-sync-check.test.ts` 只校验 zh/en 双侧 key 集合一致；**「源码使用面引用的 key 是否在定义面存在」无任何机器检查**——本次 9 个错位 key 从合入到真机暴露隔了多轮验收。

## 建议方向（未裁决）

新增使用面 vs 定义面比对守卫（pre-commit 或 CI invariants）。已人工跑通的一次性审计方法可作为原型：tsx import 真实 aggregator 树（`i18n/locales/zh-CN.ts` default export）提取全部定义 key 路径；源码正则提取使用面 key（`t('a.b.c')` / `$t()` / `labelKey` / `titleKey` 等静态字面量）；双向差集报告。

**必须解决的两个误报源**（否则守卫不可用）：

1. 模板字符串动态 key（如 `panel.tray.status.${child.status}`、`panel.tray.title.${item.kind}`）——静态正则扫不到，差集里表现为死词条
2. 对象映射表引用（如 `const LABELS = { draft: 'panel.canvas.lifecycleDraft' }` 再 `t(LABELS[k])`）——同样不是 `t()` 直调形态

误报处理可选：白名单登记 / 动态 key 前缀提取（识别 `t(\`...${` 模板取静态前缀段做集合包含判定）/ 两者结合。白名单需逐条附理由，随守卫同源维护。

## 本次修复

commit 915529f47：5 个 `*Action` 词条挪进 op 子树（定义面跟随使用面，单份无重复）、direction 两词调用点统一外层形态、settings.preset 补 collapse/expand。审计脚本为 /tmp 一次性产物，未落仓。
