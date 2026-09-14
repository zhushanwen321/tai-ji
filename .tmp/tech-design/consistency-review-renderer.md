# 阶段 3 一致性审查结论 — remove-turn-progress-bar（基线 4573f4111..HEAD）

## 审查执行形态（偏离登记）

- core+ui 区：subagent sa-b93b63ee 独立审查（常规路径）
- renderer 区：**主 agent 亲自执行**——两次派发的审查 subagent 均遭环境 SIGTERM（exit 143，与 u2 首轮 dev 同款平台异常），第三次补派加增量落盘缓解后仍被杀且报告文件未落盘。写作分离未破坏（被审代码由三个独立 subagent 编写，主 agent 仅编排）；审查清单与 subagent 同款（机械对照设计 §2.2/§2.4/§3 逐条 file:line 核实）

## renderer 区审查记录（主 agent 执行，2026-09-14）

| 核对项 | 设计坐标 | 实现证据 | 判定 |
|---|---|---|---|
| warn-only 渲染条件 | §2.2 | TurnProgressBar.vue `v-if="snapshot && snapshot.warn"`，常态零 DOM | ✅ |
| warn 态内容（Clock 警示色 + 时长 + 中止/继续等待） | §2.2 | 静态 `border-warn/35 bg-warn-soft` + `text-warn`；abort emit / snoozeWarn 按钮 | ✅ |
| awaitingUser 分型/tool/chars 段删除 | §2.2 | 模板三处全删；豁免语义改注释承载（warn 计算输入非渲染后隐藏） | ✅ |
| 组件名/testid 不变 + 头注回写（含还名四要素） | §2.2 | testid `turn-progress-bar` 不变；头注登记命名错位接受代价 | ✅ |
| Panel.vue 挂载点 dead 排除保留（W6/A6） | §2.2/§3-A6 | `v-if="panelView.kind !== 'dead'"` 逐字未动；仅注释回写 | ✅ |
| abort 链不动 | §2.2 | emit abort → Panel onProgressAbort（模板未改） | ✅ |
| formatDuration 删秒分支 + 跨包前提注释 | §2.4 round-2 S3 | MS_PER_MINUTE 两分支；注释逐字含「≥ 60s 前提 / P-3 跌破须恢复」 | ✅ |
| sidebar 四死键删除（双侧对称）+ 五键保留 | §2.4 | zh/en 各 -4 行（toolElapsed/generatedChars/awaitingUser/durationSec）；保留 turnElapsed/abortTurn/keepWaiting/durationMin/durationHourMin | ✅ |
| panel.ts 新键（双侧对称 + 出处注释） | §2.4 | `panel.message.generatedChars` zh/en 落 message 段 | ✅ |
| U6 反转（反向断言 + 头注反转登记） | §2.2 | ask-user-inline.test.ts U6 重写：跨阈值 +1s 推进断言 bar 不渲染，overlay/composer 语义保留 | ✅ |
| A1/A4/A5 用例覆盖 + D7 文案纪律 | §3 | bar 测试 11 用例：A1 常态零 DOM / A4 警示色+两按钮文案 / A5 snooze 消失且不复现 + ask_user 超阈值不出现 / 观察者形态 / durationHourMin 桶 / 双语键集合恰为保留五键（R4） | ✅ |
| A6 dead 排除脚本化 | §3（R3） | wiring 测试新增：dead + occupancy 残留 → bar 不渲染 | ✅ |

**三分类结论**：reasonable = R3/R4（已登记 §5）；unreasonable = **未发现**（本区逐条核对无违背设计/遗漏/越权）；doc_errors = **未发现**（设计 §2.2/§2.4 与实现逐字一致，含 round-2 S3 前提注释）。

## 合并结论（两区）

- 审查清零 ✅（core+ui 区 1 条 low 清单登记项已按建议补登 R5；renderer 区零 findings）
- 合理偏差登记 R1–R6 全落 §5
- Gate A 全量绿（core 2085 / ui 797 / renderer 4328 = 7210 tests；三包类型门 EXIT=0；根 lint `--max-warnings 0` 绿），证据 `.tmp/dev-flow/remove-turn-progress-bar.gate-a.log`
- 覆盖矩阵：16 改动文件全部被定向套件覆盖（u1→turn-progress.test 15 用例 / u2→bar 11 + wiring 2 + ask-user 3 + i18n 守卫 197 / u3→useTurnElapsed 16 + TurnMeta 21 + Turn 30 + smoke 5），无无人认领改动区
