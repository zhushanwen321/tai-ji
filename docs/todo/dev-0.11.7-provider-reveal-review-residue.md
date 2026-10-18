# dev-0.11.7 合入点横切审查 minor 残余（fix-provider-save 分支 · provider 保存条 / API Key 回显 / Cookie 校验）

状态：未解决（2026-10-18 dev-merge 合入点横切审查登记；must-fix 已清零，以下 2 条为 minor 级
登记项，不阻塞合并，终局 PR 期复核裁决）

## 背景

fix-provider-save 分支（settings-provider 三问题修复：保存条吸底 / 已存 API Key 眼睛回显 /
opencode+mimo Cookie 粘贴格式校验）合入 dev-0.11.7 前，经 review-fix-loop 3 维横切审查
（business-logic / arch-boundary / data-governance）。三轮运行：

- round 1（`wf-1792298957537-u6tukq`）：4 must-fix（回显态被同 id 广播重置、快照判据不一致、
  迟到响应错位、明文通道未登记）→ 全部修复并经 round 2 复核关闭。
- round 2（`wf-1792300777089-ws5287`）：4 must-fix（discover 误发回显原值、旧数据 OAuth
  眼睛按钮 fail-open、#65/#66 登记措辞矛盾）→ 全部修复。
- round 3（`wf-1792303041190-m6cgaz`，`autoCommit:false`）：round 4 三 reviewer 全员 clean
  （must-fix = 0）；loop 因 minor 建议清单不收敛以 `stuck` 退出。

循环退出的根因是 workflow 的收敛判定要求 suggestion 也归零；本轮 diff 归属的 minor 已当批
修复（Cookie `Cookie:` 头名剥离、runtime configure 归一化、i18n 恢复指引、registry 链接、
OAuth 退出 presence 事实回写、端点草稿值谓词、测试三态桩等）。以下 2 条为**正交基础架构缺口
或需人工多页验证**的项，按 dev-merge 分级「随分支带走」登记。

## 残余清单

| ID | 位置 | 问题 | 修复方向 |
|----|------|------|---------|
| SG-7 | `packages/ui/src/features/settings/common/GroupCard.vue` | `overflow: hidden → clip` 是共享组件行为变更（影响全部 48 处 GroupCard 用法）。provider 设置页已在真机验证（保存条吸底 + 圆角裁剪）；其余设置页（preset / skill / extension / system / rename-session / update / appearance）的间距与圆角裁剪尚未逐页复核。`clip` 不建立 BFC（`hidden` 会），slot 子元素 margin 可能改变间距。 | 逐页目视复核间距与圆角；若出现 margin 泄漏，在 `.group-card` 追加 `display: flow-root` 并回归 provider 页 sticky 行为。复核完成后关闭本条。 |
| SG-8 | `packages/core/src/domain/settings/use-provider-edit.ts` + `provider-edit-form.ts` | `providerRef` watcher 的「同 id 刷新早退」契约依赖调用方把 settings store 列表元素直接作为 `:provider`（当前唯一消费方 ProviderPage 合规，契约已写入 `useProviderEdit` JSDoc）。结构性收敛需要 form module 暴露 `reconcile(fresh)` 公共入口 + 同 id 分支语义 + prop-only 契约测试，属模块 API 变更，超出本次最小修复授权。 | 独立 scoped change：新增 `reconcile(fresh)` 入口（provider 变化统一经它分流 id 变化/同 id），补 idempotent store watch 与「仅 prop 变化」契约测试；完成后删除 watcher 早退分支。 |

## 已处理（终态存档）

- must-fix：两轮共 8 条全部修复并经下一轮 reviewers 复核 clean（回显生命周期、discover 凭据
  取值、OAuth presence 三态、ADR-0141 明文 carve-out 与远程可达性裁决、registry #65/#66 登记）。
- diff 归属 minor（合入前当批修复）：SG-1 registry 链接、SG-2 `Cookie:` 头名剥离、
  SG-3 runtime 重复归一化测试块删除、SG-4/SG-6 登记措辞、SG-9 `!cmd` 原值测试、
  SG-10 runtime configure 归一化、SG-12 discover 注释、SG-13 i18n 恢复指引、
  S-1 OAuth 退出 presence 事实回写、S-2 端点草稿值谓词、S-3 测试三态桩。
