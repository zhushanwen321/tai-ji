# branch-review R1 建议级残余（随分支带走）

来源：dev-merge 合入点横切审查（feat-workflow-resume → dev-0.10.5，2026-09-29，报告目录 `.tmp/dev-merge-review/`）。必修 8 条已当场全修；建议级（suggestion）按流程随分支带走，不阻塞合并，待后续排期。原 5 条中与 subagent-workflow 体系相关的 3 条（phaseSettlementTracker 回收 / record 流读取器双实现 / 事件词表手抄镜像）已并入 [subagent-workflow-issues.md](./subagent-workflow-issues.md)（§3.11 / §4.2.1 / §4.2.2），本文件只留与该体系无关的 2 条。各条证据链与修复方向见对应维度报告全文。

## 1. runtime-instance.json 契约双源（arch-boundary 维度）

- 现状：`apps/electron/main/supervisor/port-discoverer.ts:31,125-130` 本地重声明文件名常量与记录形状（pid/port/startedAt），写方 runtime 侧已有导出 SSOT（single-instance-guard.ts:36 `RUNTIME_INSTANCE_FILE` + `RuntimeInstanceRecord`）。单侧改名漂移无机器检查拦截，漂移形态 = main 判「无残留」跳过收割、残留 runtime 占端口。
- 实现要点：常量与记录形状上收 `@taiji/shared`（先例 = C-proc-18 的 `RUNTIME_PLANNED_EXIT_CODE`），两侧同 import。

## 2. shared 对 extension-protocol 的依赖分类漂移（monorepo-impact 维度）

- 现状：`packages/shared/package.json:33`——生产码新增值级依赖 `@zhushanwen/extension-protocol`（message.ts:5-8 import + :44 re-export）但只登记在 devDependencies，是全仓唯一「生产 import + devDep 声明」的包。workspace symlink 下不断链；`pnpm deploy`（只装 production deps）/ 依赖审计 / 转发布时运行时断链。
- 实现要点：该依赖从 devDependencies 移到 dependencies（一行）。
