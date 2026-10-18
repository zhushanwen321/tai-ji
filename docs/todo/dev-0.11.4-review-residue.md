# dev-0.11.4 合入点横切审查 minor 残余（fix-tool-group-style 分支）

状态：未解决（2026-10-15 dev-merge 合入点横切审查登记；11 条均为 minor/suggestion 级，不阻塞合并，终局 PR 期复核裁决补修或关闭）

## 背景

fix-tool-group-style 分支（drawer subagent 二级 tab / dispatch model-source 显示 / file-tree git 着色 / zcode provider-sync 重构 / TruncatedHistoryBar pill 化等）合入 dev-0.11.4 前，经 review-fix-loop 4 维横切审查（business-logic / arch-boundary / data-governance / monorepo-impact）。4 条 must-fix（critical 1 + major 3）已当轮修复并核实；以下 minor 残余按 dev-merge 分级「随分支带走」登记，终局 PR 期逐条复核。

审查运行记录：review-fix-loop run `wf-1792062598727-3ewokg`（base c15483849）。

## 残余清单

| ID | 位置 | 问题 | 修复方向 |
|----|------|------|---------|
| S-1 | `runtime/services/zcode-provider-sync.ts` vs `zcode-subagent-cli/src/preparer.ts`（readAccountFamilyRules / pushAccountFamilyRuleModels） | account 家族清单判据跨包两处漂移：去重粒度（providerId 级 vs 模型级）与空 `builtinModelIds` 回落语义相反；settings 清单与引擎 listModels 可产出不同集合，偏好层成员校验有缝隙 | 统一为模型级去重 +「数组在位即用（含空），缺键才回落 personal」，任一侧注释登记对齐点 |
| S-2 | `subagent-core/execution/service/run-orchestration.ts`（pi 分支）+ `workflow-dispatch.ts` 同构点 | pi 路由 `modelSource` 判定忽略 frontmatter：agent .md 声明了模型的 subagent 详情页标注「引擎缺省」，展示语义与事实不符 | pi 分支改三层判定 `opts.model ? "explicit" : (agentConfig?.model ? "frontmatter" : "default")` |
| S-3 | `subagent-core/execution/service/workflow-dispatch.ts`（consultOverrideAtTaskSpec 非 pi 分支） | 模型覆盖路径绕过翻译面直写 record.model（pi 词汇 ref），违反「record 呈现实际发给引擎的 ref」不变量；zai 通道覆盖场景 UI 显示引擎从未收到的 ref | restamp 前经 `engine.translateModelRef?.(overrideRef) ?? overrideRef`（幂等） |
| S-4 | `renderer/composables/panel/useSubagentDrawerTabs.ts` | `enteredFrom === null` 时 activate/close 跳过停流与加载编排：旧 tab 流不停、新 tab 不加载（当前生产调用点均非 null，隐性分叉） | 数据编排改挂 `activeTab` 变化或解除 enteredFrom 门控 |
| S-5 | 同上 activate/close 入口 | `focusedSid` 为空串时仍执行并惰性创建 `''` 键退化分区（watch 入口有真值检查，这两处没有） | 入口补 `if (!focusedSid.value) return` |
| S-6 | `apps/electron/main/utils/local-file-prefixes.ts`（isPathUnderSessionTmp） | `.tmp/` 准入只做词法 resolve 不解析 symlink：模型可控符号链接可指向任意文件经预览通道读出（与 ADR 已登记代价同粒度的硬化建议） | session-tmp 分支加 `realpathSync` 复核，或文档登记「按词法前缀跟随」 |
| S-7 | 同上文件 `<cwd>/.tmp` 目录自身形态分支 | cwd=`/` 时产出空串候选，依赖 `encodeCwd('')` 巧合行为（R1 报告引用行号在现文件不存在，疑行号漂移；问题本身成立性待复核） | 切片为空/根时跳过该候选（fail-closed） |
| S-9 | `shared/src/subagent.ts:756` 注释 | 注释称与 subagent-core 本地类型副本「逐字段等值」但未给副本路径，双侧同步无机器检查 | 补双侧字面量对拍单测 + 副本路径 |
| S-11 | 注释漂移族：`core/transport/api/domains/file.ts:18` + `runtime/services/file-service.ts:92`（showIgnored 已退役）/ `TurnSummary.test.ts:166` / `fork-entry-behavior.test.ts` | 注释与现行事实不符（共 4 处） | 按现行事实改写 |
| S-12 | Panel.vue composer band / Block.vue actions 行 / TruncatedHistoryBar pill | 几何变更落在 e2e-visual 像素基线射程内（提醒，非缺陷） | CI PR 期 L1 固定环节自动跑 e2e-visual；红则按基线重录流程处置 |
| N-1 | `useSubagentDrawerTabs.ts` + `core/domain/drawer/selection/subagent.ts` | clearSubagentSelection 清 current 分区而其余读写以 focusedSid 为键，依赖「current == focused」隐式不变量，接口侧未声明 | 加可选 sid 参数走 updateFor(sid)，或注释声明前提 |

## 已修复（终态存档）

R1 must-fix 4/4 当轮修复并经聚合方抽查核实：MF-1（critical）模型来源标注 i18n 键形态错配（locale 扁平键 vs 运行时嵌套取键，badge/title 恒显示键名）；MF-2（major）偏好层模型翻译 throw 绕过声明的降级语义；MF-3（major）drawer 关闭最后 tab 后 core 选中态残留；MF-4（major）install-hooks.sh eslint --fix 回 add 面漏扩。S-10（测试卫生：[dbg] console.log + 未用 import）亦已修（83884b87c）。

## 流程注记

两笔审查修复 commit（39f7f7740 / 83884b87c）的 message 口径超出实际修复范围（审查 Info I-1 / N-1 指出，已提交不改写）——后续修复 commit message 按实际修复条目描述。
