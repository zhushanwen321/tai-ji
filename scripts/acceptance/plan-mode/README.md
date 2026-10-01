# plan 模式验收资产（U0 验收资产前置）

> 设计 = `.tmp/tech-design/plan-mode-state-machine.md`（§4 验收场景 S1-S16 / §3.3 D4、D7③）；
> 实施计划 = `.tmp/dev-flow/plan-mode-state-machine.impl-plan.md`（U0 单元）。本目录是 U0 唯一领地。
>
> 三件资产 + 一份复现基线：**mock pi 脚本族**（确定性时序/崩溃构造）、**S5 fixture 技能模板**（执行方式三档弹窗构造）、**CDP 等待断言脚本**（抑制窗/稳定窗/兜底窗断言脚本化）；
> **mock pi 对现版的 F1-F5 症状复现基线** = `.tmp/dev-flow/mock-pi-repro-baseline.md`。
> 全部零 token、确定性可复跑；U6 真机验收「只跑不建」。

## 目录

```
scripts/acceptance/plan-mode/
├── README.md                     # 本文件
├── mock-pi/
│   ├── mock-pi.mjs               # pi 替身主程序（JSONL over stdin/stdout，--mode rpc 协议面）
│   ├── lib/frames.mjs            # 协议帧构造器（含 error envelope + 边界帧族）
│   ├── lib/scenario.mjs          # 场景剧本加载 + 参数化（优先级：默认 < 剧本 < config < env）
│   ├── lib/session-writer.mjs    # session JSONL plan-state 快照写入（现版 persistPlanState 形态）
│   ├── scenarios/*.json          # 声明式剧本（见下表）
│   ├── install-mock-pi.mjs       # node_modules/.bin/pi 文件级置换（wrapper + 回执）
│   ├── restore-mock-pi.mjs       # 三证恢复（S12 纪律，见下）
│   └── selftest.mjs              # 自测入口①
├── fixture-skill/
│   ├── fixture-skill.mjs         # S5 fixture 技能生成/清理（--dry-run 支持）
│   ├── templates/SKILL.md.template  # plan-exec: true frontmatter 模板
│   └── selftest.mts              # 自测入口②（tsx；真实 detectExecSkills 实测）
├── cdp/
│   ├── assert-window.mjs         # 等待断言（suppress / zero-render / fallback-not-lit / eventually）
│   ├── lib/cdp-client.mjs        # 最小 CDP 客户端（Node 内建 fetch + WebSocket，零依赖）
│   ├── lib/sampler-script.mjs    # 页内采样器（CDP 与自测 vm 沙箱同一份代码）
│   └── selftest.mjs              # 自测入口③（采样语义 + 对 dev 实例空跑）
└── repro/
    ├── repro-baseline.mjs        # F1-F5 症状复现基线 runner（产 .tmp/dev-flow/mock-pi-repro-baseline.md）
    └── derive-probe.mts          # 真实派生函数探针（scanPlanStateEntries + derivePlanStage，零镜像）
```

## 自测入口（三件各有，全绿为交付前提）

```bash
node scripts/acceptance/plan-mode/mock-pi/selftest.mjs                       # ① mock pi 起停/延迟/崩溃/边界帧/装恢复（31 用例，~10s）
node_modules/.bin/tsx scripts/acceptance/plan-mode/fixture-skill/selftest.mts # ② fixture 生成/清理 dry-run + 真实检测（9 用例，~5s）
node scripts/acceptance/plan-mode/cdp/selftest.mjs                            # ③ CDP 断言语义 + 对 dev 实例空跑（15 用例，~3s）
# ④ 复现基线（验收条款②，产物落 .tmp/dev-flow/mock-pi-repro-baseline.md）
node scripts/acceptance/plan-mode/repro/repro-baseline.mjs --out .tmp/dev-flow/mock-pi-repro-baseline.md
```

## ① mock pi 脚本族

**形态** = `node_modules/.bin/pi` 文件级置换（AGENTS.md「验收构造 mock pi」纪律）：runtime 的
`find-pi-executable` 解析链命中新 spawn，窗口结束三证恢复。

```bash
# 装（写 active config + wrapper，原 symlink 移为 pi.bak，落安装回执）
node scripts/acceptance/plan-mode/mock-pi/install-mock-pi.mjs --scenario select-delay-1500ms

# 参数覆盖（select 登记延迟任意值——S3 靶向 1.5s；或 env TAIJI_MOCK_PI_SELECT_REGISTER_DELAY_MS）
node scripts/acceptance/plan-mode/mock-pi/install-mock-pi.mjs \
  --scenario plan-review-pending --params '{"selectRegisterDelayMs":1500}'

# 恢复（三证，见下「S12 恢复纪律」）
node scripts/acceptance/plan-mode/mock-pi/restore-mock-pi.mjs
```

**剧本表**（`mock-pi/scenarios/`，声明式 JSON；字段语义见 `lib/scenario.mjs` 头注）：

| 剧本 | 用途（对应场景） |
|------|------------------|
| `plan-review-pending` | 基础：plan-state(approval awaiting) 落盘 + 审批 select 挂起（S1/S2 起点） |
| `select-delay-1500ms` | **S3 稳定窗靶向**：persist→select 登记延迟 1.5s（<2s 稳定窗覆盖域，配 CDP zero-render 断言） |
| `crash-immediate` | **S6/S7 杀进程**：select 挂起后 SIGKILL 自杀（审批/表单挂起中崩溃恢复构造） |
| `crash-on-abort` | **崩溃注入**：收到 abort 即 SIGKILL（F4①「abort 无法完成」前置） |
| `abort-unanswered` | abort 无应答（F4② 60s 阶梯 / renderer 65s backstop 窗口构造） |
| `boundary-frames` | **协议边界帧族**：空载荷（options 空/空串）+ 非法形态（非法 JSON / docs 非数组）+ 超限（selfReview>4KB / requirement>64KB / 巨文本）+ error envelope 应答 |
| `repro-dismiss-no-persist` | F1/F3 复现（现版 cancelled 分支不落盘） |
| `repro-exec-form-pending` | F5 复现（approve 后先清 reviewState 再挂执行方式表单三档） |

**能力面**：命令应答族（ok / **error envelope** / get_messages）· select 登记延迟参数化（config/`TAIJI_MOCK_PI_SELECT_REGISTER_DELAY_MS` 双通道）· 杀进程/崩溃注入（`onPrompt.crash` / `abortMode: crash` / `onAbort.exit`）· `extension_ui_response` 消费链（respond → 落盘改态 → 第二 select）· marker 字面量与 extension-protocol 的漂移自检（selftest `marker-literal-drift`）。

### S12 恢复纪律（验收结束恢复三证，缺一不算恢复）

**任何使用 mock pi 的窗口结束必须执行 `restore-mock-pi.mjs`，三证齐才可宣布恢复**：

1. **证① symlink 还原**：`pi.bak` 移回 `pi`，lstat 形态/链接目标与安装回执一致；
2. **证② `--version` 真实输出**：`node_modules/.bin/pi --version` 输出真实 pi 版本（非 mock 标记）；
3. **证③ `ls -l` 形态核对**：`ls -l node_modules/.bin/pi` 显示 symlink `->` 目标形态（restore 会留证到 `~/.taiji-dev/mock-pi/restore-evidence.json`）。

restore 自动跑三证并以 exit code 表态（0 = 三证齐）；三证不齐须人工核对，窗口期间禁止起依赖真实 pi 的新场景。

## ② S5 fixture 技能模板（执行方式三档弹窗构造）

设计 D7③：fixture 技能落在**独立测试项目目录**的项目级 `.agents/skills/`（exec-skills 四根扫描含祖先链，trusted 项目生效），不污染 `~/.agents/skills/`；frontmatter 规定 = `plan-exec: true` **严格布尔**（字符串 "true" 不命中）+ `description` 必填（pi description 门）。

```bash
# 生成（独立测试项目目录，模板 templates/SKILL.md.template）
node scripts/acceptance/plan-mode/fixture-skill/fixture-skill.mjs create --dir ~/.taiji-dev/plan-fixture-project

# 生成/清理 dry-run（动作清单、零落盘）
node scripts/acceptance/plan-mode/fixture-skill/fixture-skill.mjs create --dir <目录> --dry-run
node scripts/acceptance/plan-mode/fixture-skill/fixture-skill.mjs clean  --dir <目录> --dry-run

# 清理（S12：fixture 技能目录已清理无残留；--all 回收空目录）
node scripts/acceptance/plan-mode/fixture-skill/fixture-skill.mjs clean --dir <目录> --all
```

安全网：`clean` 只认带 `.taiji-plan-mode-fixture` 标记（create 写入）的目录，防误删。
真机用法：以该目录为项目跑 S1 → 确认执行 → 断言弹窗三档「用技能「fixture-exec-skill」执行 / 普通执行 / 暂不执行」（S5）；无技能环境反向断言 = 不弹恒两项死表单（S4）。

## ③ CDP 等待断言（抑制窗/稳定窗/兜底窗）

断言口径对齐设计 §3.3 D4 与 §4 S2/S3；全部可参数化（testid 更名直接传参，脚本无需改）。

```bash
# S2「点后 3s 不闪 degraded」（抑制窗）
node scripts/acceptance/plan-mode/cdp/assert-window.mjs --kind suppress

# S3「persist→pending 间隙内零渲染」（稳定窗；间隙 = mock pi 1.5s 构造，先跑 assert 再触发重挂）
node scripts/acceptance/plan-mode/cdp/assert-window.mjs --kind zero-render --window-ms 1500

# 「10s 兜底不亮」（可点 degraded 冷拉对账后才可渲染）
node scripts/acceptance/plan-mode/cdp/assert-window.mjs --kind fallback-not-lit

# 正向等待（如审批条回到 ready 三键）
node scripts/acceptance/plan-mode/cdp/assert-window.mjs --kind eventually --selector '[data-testid="plan-review-bar"]'

# 对 dev 实例空跑（解析 dev-instance --print CDP 端口，打印执行计划，不连接不断言）
node scripts/acceptance/plan-mode/cdp/assert-window.mjs --kind suppress --dry-run
```

| kind | 默认断言 | 默认 selector / 谓词 / 窗 |
|------|----------|---------------------------|
| `suppress` | 窗口内**零渲染**（3s 不闪） | `[data-testid="plan-review-degraded"]` / visible / 3000ms |
| `zero-render` | 窗口内**零渲染**（间隙内零渲染） | 同上 / visible / 1500ms |
| `fallback-not-lit` | 窗口内**可点零渲染**（10s 兜底不亮） | 同上 / clickable / 10000ms |
| `eventually` | 窗口内**出现** | `[data-testid="plan-review-bar"]` / exists / 30000ms |

谓词：`exists`（DOM 命中）/ `visible`（getClientRects 非空）/ `clickable`（visible 且非 disabled/aria-disabled）。
覆盖参数：`--selector` `--predicate` `--window-ms` `--poll-ms` `--label` `--cdp-port|--cdp-url` `--page-pattern`。
退出码：0 断言通过（或 dry-run）/ 1 断言失败 / 2 环境错误。真机连接 = `TAIJI_DEV_BACKGROUND=1 pnpm dev` 起实例后直接跑（browser-automation skill 的 CDP 接入纪律适用）。

## ④ F1-F5 症状复现基线

产物 = `.tmp/dev-flow/mock-pi-repro-baseline.md`（生成命令见上「自测入口④」，可重复生成）。
层级声明：F1-F5 各条 = 协议/持久/派生层**实跑**（mock pi 剧本 + `derive-probe.mts` 直接调用现版
`scanPlanStateEntries` / `derivePlanStage`，零镜像面）+ **GUI 层构造法**（真机复现步骤，归 U6 执行）；
偏离点与原因在基线文档「deviations 说明」节。

## 边界与纪律

- mock pi 写 session JSONL 是「扮演 pi 本人」的持久化通路（等价真实 pi-plan 扩展 `persistPlanState`），仅在 `switch_session` 附着后写入；自测/复现一律 tmp 文件（AGENTS.md「测试禁止触碰真实数据目录」纪律）。
- marker 字面量镜像 `packages/extension-protocol`（`core/markers.ts` 带尾冒号 / `extensions/ui-form/marker.ts` 无尾冒号）——改动 marker 必同步 `mock-pi/lib/frames.mjs`（selftest `marker-literal-drift` 机器拦截）。
- 采样器代码 CDP 与自测 vm 沙箱**同一份**（`cdp/lib/sampler-script.mjs`），语义零分叉。
- 临时探针纪律：本目录全部脚本即交付资产（非临时探针）；历史一次性探针用完即删。
