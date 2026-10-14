# branch-review minor 残余（dev-merge 1.7 审查随分支带走项）

状态：登记待终局 PR 期复核（dev-merge 流程 1.7 步产出，2026-10-14；4 维审查全 pass / 4 must-fix 已修复并经复审确认，本页 = suggestion 级残余）

审查报告：`.review/branch-review/*.md`（含 recheck）

## 待裁决

- [ ] `.changeset/composer-stop-compacting.md` 声明 `@taiji/electron: patch`，但该包 `private: true` 且在 changeset ignore 名单——三条发布通路均不消费，文件将永久滞留（monorepo-impact 维）。修复方向：删除，app 级描述交由 merge 阶段 release notes 承载。**待用户裁决（用户手笔文件）**。

## 注释/文案漂移（低风险，顺手修）

- [ ] `apply-system-to-dom.ts:57` 注释「三区域均 medium」与本次 SSOT 改动（chat 默认 → small）矛盾（arch-boundary / data-governance 双维命中）
- [ ] `composer-shell.ts` `sendButtonStopTarget` 注释不变量「非空 ⇔ sendButtonState === 'stop'」在 settling+bash 组合不成立（state='queue' 而 target='turn'；当前零行为影响）
- [ ] generating∧compacting 组合下 stop 按钮 title 误标「终止压缩」（实际语义 = 停止回合）
- [ ] zcode launcher 跳过日志「目录已定位但无条目」文案未区分「损坏文件」态，排障可能误导（recheck 新增）

## 模式/护栏缺口（登记例外或后续迁移）

- [ ] `useLoadMoreHistory.ts` slowLine 延续实例级状态 + watch(sessionId) 复位形态（ADR-0049 禁止项的存量延续）——迁移到 useSessionScopedState 或登记例外理由
- [ ] signal-forensics 头注的 pi rpc-mode 信号断言（rpc-mode.js:283）有锚点但缺版本钉/行号，未入 pi-semantics.json 登记
- [ ] signal-forensics `readFooter` 正则漏 pi read footer 的 `(50KB limit)` 变体（`[Showing lines A-B of C (50KB limit). ...]` 不匹配 `of \d+\.`）
