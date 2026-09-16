# composer-pi-shortcuts L4 真机验收报告（末组 A6+A7）

- 日期：2026-09-16
- 执行者：A6+A7（一次 dev 实例会话连测 3 场景：S3/S8/S9）
- 环境：dev 实例 `TAIJI_DEV_BACKGROUND=1 pnpm dev`（worktree feat-shortcut-follow-pi，CDP 9518 / Vite 1628 / runtime 3670），真实 LLM（provider router @ 192.168.1.202:9980）
- 行为规格：docs/design/composer-pi-shortcuts.md §4 场景表 S3/S8/S9 行
- 键盘注入：Playwright over CDP（trusted 事件，与 a2a4/a5 同通路）；fork 提交经 `fork-send-btn` 点击
- console 采集：全程 CDP Runtime.consoleAPICalled / Log.entryAdded（a6a7/console-capture-a6a7.log）
- 产物目录：a6a7/（截图 + 本报告 + console 日志）

## 总结

| 场景 | 结论 |
|---|---|
| S3 landing ctrl+p 切模型 → 首发建 session 用该模型 → 新 session shift+tab 生效 | **PASS** |
| S8 fork staging 暂存态 shift+tab/ctrl+p 改暂存值 → 提交 fork → 源不变 + fork 用暂存值 | **PASS**（runtime spawn 参数级实锤） |
| S9 non-reasoning 模型（档位集仅 off）shift+tab no-op | **BLOCKED**（dev 环境不可构造；L1 用例已覆盖，44/44 绿） |

2 pass + 1 blocked，无 fail。blocked 仅为环境不可构造，非实现缺陷（见 S9 节）。

---

## S3：landing 切模型 → 首发 session 继承 → 新 session 档位切换 —— PASS

**操作**：新任务页（landing，session 未建，基线 chip = GLM-5-Turbo / 低），composer 聚焦按 ctrl+p 1 次 → 输入首发消息「S3验收：请只回复四个字：模型正常」Enter 提交 → session 创建后核对模型 → shift+tab 两次核对档位链。

**观察**：

| 步骤 | 实际 | 判定 |
|---|---|---|
| ctrl+p（landing） | 模型 chip GLM-5-Turbo → **GLM-5.1**；档位 chip 低 → 高（随新模型回执快照，同 a5 报告 S7/S12 附带观察的既有行为）；焦点保持 composer | ✓ |
| 首发消息提交 | 新 session「S3模型验收测试」创建（01a0a95b），composer chip = **GLM-5.1 / 高** | ✓ |
| session 详情真值 | pi session 文件 `..._01a0a95b-*.jsonl`：`modelId: glm-5.1`、`provider: zai-coding-cn`、`thinkingLevel: high`——与 landing 所选完全一致 | ✓ |
| shift+tab 第 1 次（已建） | 档位 chip 高 → **关**（GLM-5.1 归一集 关/极简/低/中/高，表尾绕回表头）；pi 文件新增 `thinkingLevel: off` | ✓ |
| shift+tab 第 2 次（已建） | 档位 chip 关 → **极简**；pi 文件新增 `thinkingLevel: minimal`；焦点仍在 composer | ✓ |

landing → 已建迁移无断裂：landing 所选模型经首发 create 透传成为 session 真值，shift+tab 在新 session 上按归一序正常循环且 RPC 回执落盘。

**证据**：s3a-landing-ctrlp-glm51.png / s3b-session-created-chip.png / s3c-think-popover-check.png（GLM-5.1 popover 5 档 + 高✓）/ s3d-shifttab-after.png / s3e-shifttab-minimal.png + pi 文件字段引用（上表）

**操作注记**：第一次 shift+tab 尝试未生效——原因是前一步 Esc 关闭档位 popover 后焦点落在 chip 按钮上（非 composer）。重新聚焦后立即生效。属操作时序，非缺陷（动作表按设计仅在 composer 聚焦时触发）。

## S8：fork staging 暂存切换 + 提交透传 —— PASS

**操作**：源 session「秋天山间散文创作」（01a0a924，基线 chip = GLM-5-Turbo / 低），hover 末条 AI 回复点 fork 按钮（`fork-ask-btn`）进入 staging（composer 出现 `composer-mode-chip`「将发到新分支 · 与主线隔离」+ `fork-send-btn`）→ composer 聚焦按 shift+tab ×3、ctrl+p ×1 改暂存值 → 输入「S8 fork 验证」点 fork-send-btn 提交 → 分别核对源 session 与新 fork session。

**观察**：

| 断言 | 实际 | 判定 |
|---|---|---|
| staging chip 切换 | 暂存模型 GLM-5-Turbo → **GLM-5.1**（ctrl+p forward 一步）；暂存档位 低 →…→ **中**（shift+tab 循环，见下方观察项） | ✓ |
| 源 session 不变 | 提交后留在原线（fast-fork 语义），消息流出现 fork notice「已在新分支提问S8 fork 验证」；源 chip 保持 **GLM-5-Turbo / 低** | ✓ |
| 新 fork session 用暂存值（UI 面） | fork session（9a3f7d54）composer chip = **GLM-5.1 / 中**；继承源历史 + 首条 user 消息「S8 fork 验证」 | ✓ |
| 新 fork session 用暂存值（pi 面） | 新 turn 全部 assistant 消息 `model: glm-5.1`（provider zai-coding-cn） | ✓ |
| 新 fork session 用暂存值（进程面，决定性） | runtime 日志 08:42:06 spawn fork pi 进程命令行：`--model zai-coding-cn/glm-5.1 … --thinking medium`——**getStagingConfig 透传的 modelOverride / thinkingOverride 直接落在 spawn 参数** | ✓ |

**证据**：s8b-fork-staging-initial.png / s8c-fork-staging-changed.png / s8d-fork-before-submit.png / s8e-after-submit.png（源不变 + fork notice + 分支组）/ s8f-fork-session.png（fork session chip）+ runtime-2026-09-16.log L1378 + pi 文件 9a3f7d54 entry 11-22

**附带观察项（非缺陷，登记备查）**：

1. **staging 首按起点时序窗**：S8 主链中 staging 初始 chip 显示「低」，但首按 shift+tab 从「关」起算（低→极简，按 §3.3 起点规则 undefined/脏值 → 取归一集第一档）；此后 极简→低→中 正常 forward。复测对照（等 session 真值就绪后再进 staging）：首按 低→**中** 正常。归因：session 刚切换、真值尚未加载完成时立即进入 staging，快照（`enterStagingMode`）抓到占位值——该窗口属 staging 既有通路（快照机制与 popover 共用，非本次动作表改动引入），行为可预期（按设计内起点规则收敛）。触发条件苛刻（切 session 后 ~2s 内点 fork），实际影响极小。
2. fork session 的 pi 文件继承源历史的 model_change（mimo/high，源 session 创建时默认值），spawn 参数才是生效模型——文件史与生效态并存属 pi session 格式语义，非缺陷。

## S9：non-reasoning 模型 shift+tab no-op —— BLOCKED（环境不可构造，L1 已覆盖）

**任务预案**：抽验 1 条——non-reasoning 模型（档位可用集仅 off）选中时按 shift+tab → 无反应无报错无 toast；若 dev 环境无此类模型则如实报 blocked。

**环境普查（真机实测）**：在 landing 态用 ctrl+p 遍历全部 enabled 模型（绕回一圈闭合），逐个打开档位 popover 记录可用集：

| 模型 | 档位集 | 模型 | 档位集 |
|---|---|---|---|
| GLM-4.6V | 关/极简/低/中/高 | GLM-5.2 Highspeed | 关/高/最高 |
| GLM-4.7 | 关/极简/低/中/高 | GLM-5.3 | 关/低/高/最高 |
| GLM-5-Turbo | 关/极简/低/中/高 | GLM-5.3-Flash | 关/低/高/最高 |
| GLM-5.1 | 关/极简/低/中/高 | GLM-5.3 Highspeed | 关/低/高/最高 |
| GLM-5.2 | 关/高/最高 | GLM-5V-Turbo | 关/极简/低/中/高 |
| MiMo-V2.5 | 关/极简/低/中/开 | MiMo-V2.5-Pro | 关/极简/低/中/开 |

12 个模型档位集均 ≥3 档，**不存在「仅 off」的 non-reasoning 模型**——真机无法构造该环境。

**L1 覆盖核实**：`composer-shortcut-actions.test.ts` L409 用例「档位可用集仅 off：shift+tab no-op（键吞掉、无动作、无噪音）」+ L421「模型列表 ≤1 或空：ctrl+p / ctrl+shift+p no-op」在列；本次实跑该测试文件 **44/44 passed**。

**正向部分观察**：no-op 守卫条件（`levels.length <= 1`）在全部 12 个模型上均不触发，shift+tab 在所有模型上正常循环——无误触发。

**结论**：blocked（真机不可构造），注明「L1 用例『档位可用集仅 off：shift+tab no-op』已覆盖」。未强行编造。

---

## console 问题清单（与本次改动相关）

验收操作期间**零新增**与快捷键相关的 console warning/error（无 `[composer-shortcut] ... RPC failed`——全部切换 RPC 成功）。既有观察项（非本次改动面，登记备查）：

1. `[Vue warn] onScopeDispose() ... no active effect scope` ×2 @ 启动期（与 a2a4/a5 报告一致，早于任何操作）。
2. `[core/coordination] session-level message missing sessionId, routed to global: session.forkNotice` @ 08:42:10（S8 fork 提交时刻）——fork notice 广播通路的既有告警，S8 提交走按钮点击不经本次改动的键盘链。
3. `[pin-bottom-guard] follow 频率异常（61 次/1000ms > 60）` ×4 @ 08:43——fork session 流式渲染期间 virtualizer 滚动跟随的既有守卫日志（chat-pin-bottom-fix.md §4.5 已登记的观察循环形态）。

## 环境观察（不影响结论）

- 模型列表在本次会话中为 12 个（S2 时记录 8 个）——上游 router 模型集动态变化，与快捷键行为无关（循环序 = enabled 列表自然序，行为一致）。
- landing 态档位/模型 chip 承载上一次 authored 记忆（S3 设置的 GLM-5.1 / 高在重进 landing 后仍在）——既有 pending/lastUsed 语义。
