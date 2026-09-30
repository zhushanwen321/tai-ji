# 约束 SSOT：11 条 enforcement 引用已退役 review agent（P1，待裁决补全）

状态：待裁决（2026-10-01 登记，plan-mode 分支 dev-merge branch-review 发现）。根因 = pr-cr-fix 退役 review-type-safety / review-test-coverage 两维度时未把 docs/constraints.json 的 enforcement 同步（该 SKILL「登记见 docs/constraints.json 现行条目」的声明不成立）。

## 症状

`node scripts/validate-constraints.mjs` 实跑 exit 2 / 11 条「review agent 不存在于 .agents/skills/*/agents/」——docs/constraints.json 有 11 条约束的 enforcement 引用两个已退役的 pr-cr-fix 审查 agent（文件在全仓与 ~/.agents 均不存在，git 历史已删；现役 agent 实体只有 dev-merge 的 6 个与 pr-cr-fix 的 simplify-apply）：

- review-type-safety ×7：C-pi-05（pi-protocol.ts 真契约）/ C-comm-07（command<K>() 类型化原语）/ C-state-02（Segment[] 判别联合）/ C-state-07（领域类型 SSOT）/ C-pi-13（改状态 RPC reply 生效值）/ C-pi-15（mutation reply 生效值字段）/ C-proc-23（引擎协议四张词表锁）
- review-test-coverage ×4：C-ext-05（SDK 契约测试覆盖）/ C-proc-01（vitest 唯一框架）/ C-proc-02（测试三视角）/ C-data-17（resolveLaunchConfig 单解析点，该条另有一条现行在效的 review-data-governance）

11 条均在合并基线 b3bbb935 上即存在，不是 plan-mode 分支引入。校验器在 ADR-0076 迁移前按硬编码 pr-cr-fix 路径检查同样会报错，但该 hook 只在 docs/constraints.json 被 staged 时触发，故长期未被发现；plan-mode 分支把校验器修为按 skills 目录枚举（commit a25b3336b）后存量才被如实曝光。**裁决落地前，此状态阻断任何改 docs/constraints.json 的提交（pre-commit exit 2）**；11 条约束当前实际处于无执行方式状态，其中 C-pi-13 是 pi 边界 P0 级约束（防「request≠effective 窗口显示假值」事故复发的防线）。

## 为什么不能顺手改（2026-10-01 主 agent 划定的裁决边界，三个候选方向均核实堵死）

1. **转 machine 承接**：C-pi-13 的权威源 docs/architecture/pi-boundary-reliability.md G6 行明裁「机器化（静态判定『改状态』语义）不可靠，诚实停在 review 级（review-type-safety agent 消费）」；且 coverage-gate 是 pr-lifecycle workflow step、测试锚点（如 C-proc-23 的 contract-closure.test.ts 族）在 packages/ 下，都不在 machine hook 白名单目录（.githooks/ / scripts/ / 仓库根），无合法 hook 可指。
2. **改指现行 6 个 dev-merge review agent**：语义错配——4 条 test-coverage 约束正是因该维度无 agent 覆盖才整维度退役；7 条 type-safety 的语义（协议类型镜像 / command<K>() 原语 / 判别联合 / 改状态回执 / 引擎词表锁）也没有现成 agent 精确承接。
3. **置 type:"none"**：静默降级 11 条约束的执行强度，schema 无备注字段可承载理由，含 C-pi-13 这条 P0 级约束。

## 待裁决内容

逐约束补全 enforcement 执行方式，需三类输入：① per-constraint 机制盘点（哪些约束实际已被 tsc/eslint/守卫测试覆盖、哪些只剩 review 级纪律）；② C-pi-13 的 review 级承载由哪个现役 agent 承接，或不设 agent、以 ADR 级复裁（原 G6 裁决的载体已退役，裁决本身失效需重做）；③ enforcement schema 是否扩展新类型以合法表达「测试文件锚点 / workflow step」类执行机制（当前 machine hook 形态表达不了）。落地时按 pi-boundary-reliability G7 行纪律「登记与对应护栏同 commit 或护栏先行」，并同步 pr-cr-fix SKILL 的承接声明与相关约束条目 summary。
