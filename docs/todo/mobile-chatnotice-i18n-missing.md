# 移动壳缺 chatNotice 翻译注入

状态：未修复（dev-merge 前置 branch-review 第 2 轮 minor 发现 dmg-r2-2，2026-10-25 登记；随 fix-chat-flow-order 分支合入，留终局 PR 期复核）。

现象：停止/截断提示行（chatNotice 族）在移动壳渲染 i18n 键名原文而非译文——桌面壳的翻译注入通路已接，移动壳 bootstrap 缺同一注入，双壳行为分叉。

修复方向：`packages/mobile-renderer/src/bootstrap.ts` 补 chatNotice 翻译注入（与桌面壳同源词典），判定逻辑复用 `packages/core/src/domain/chat/effects/notice-text.ts`，不复制词典。
