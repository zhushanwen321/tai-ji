# Visual Regression Baselines

C 层 Playwright 像素 diff 的 baseline 快照。

## 目录结构

```
e2e/visual-baselines/
├── README.md                      # 本文件
├── shell.spec/                    # shell.spec.ts 的 baseline（snapshotPathTemplate 按 spec 文件名分目录）
│   └── shell-default.png          # AppShell Landing 态整页
└── composer.spec/                 # composer.spec.ts 的 baseline
    └── composer-default.png       # 激活 session 后 composer-box 区域
```

baseline 必须 **git tracked**（Q3/D3）：CI / 其他开发者 clone 后无 baseline 则 diff 无意义。`e2e/visual-baselines/` 不在 `.gitignore`。

## 运行命令

```bash
# 跑 visual 回归（baseline 存在则对比，default project 自动隔离）
npx playwright test e2e/visual

# 只跑某 spec
npx playwright test e2e/visual/shell.spec.ts

# 指定 project（一般无需，testMatch 已隔离）
npx playwright test e2e/visual --project=visual-chromium
```

visual-chromium project 与 electron project 经 `testMatch`/`testIgnore` 互斥隔离（electron 跑 `e2e/**` 排除 `visual/**`，visual-chromium 只跑 `visual/**`）。跑 electron 行为 E2E 不会起 vite，互不干扰。

## 生成 / 更新 baseline

**首次生成或视觉故意变更后更新**：

```bash
npx playwright test e2e/visual --update-snapshots
```

`--update-snapshots` 会把当前渲染写入 baseline（缺失则创建，存在则覆盖）。更新后 **必须 git add + commit** baseline PNG。

### 何时需要更新

| 场景 | 操作 |
|------|------|
| 视觉重构（F4 C1 token 反写、v6 落地） | 改动落地后 `--update-snapshots` 重新生成全部 baseline，commit |
| 新增 visual spec | 首次 `--update-snapshots` 生成该 spec baseline |
| 非预期的 diff 失败（回归 bug） | **修代码**使 diff 归零，**禁止**直接 update（update 会把回归写进 baseline） |
| 预期的 diff 失败（故意视觉改动） | 确认改动符合预期后 update + commit |

## 回滚

baseline 是普通 git 文件，回滚用 git：

```bash
# 回滚单个 baseline 到 HEAD
git checkout HEAD -- e2e/visual-baselines/shell.spec/shell-default.png

# 回滚全部 baseline
git checkout HEAD -- e2e/visual-baselines/
```

若 update 后发现改错了，`git checkout` 恢复，无需重跑。

## 阈值策略

baseline 对比用 `maxDiffPixelRatio: 0.01`（1%）+ `caret: 'hide'`（隐藏输入光标，消除 caret 闪烁 flaky），见各 spec 的 `toHaveScreenshot` options。

- **0.01 ratio**：容忍微小 flaky（字体抗锯齿 / caret 闪烁 / 动画残余，实测 ~11px）。真回归（大面积视觉改动）远超 1% 仍被抓住
- **严格模式**：临时调查时可在 spec 改 `maxDiffPixelRatio: 0`（零容忍）定位所有差异源，但日常不用（会 flaky）
- **已知局限**：内容稀疏页面（如 Landing 态）的单 CSS 变量改动（如 `--bg`）可见区域可能 <1%，被阈值容忍。验证大面积改动灵敏度应改影响大面积可见元素的变量（如 `--surface` panel 背景）

### AC3 验证记录（W3）

W3 验证 diff 机制有效性（ERR4）：注入 `--surface: #ff0000`（panel 背景全红）→ shell.spec 检测到 **633957 pixels diff（62%）**，exit 非0 + 产出 expected/actual/diff 三图。还原后 exit 0。

> 注：任务原建议改 `--bg`，但实测 Landing/composer 态 `--bg` 可见区域被 main panel（`--surface`）覆盖，占比 <1% 被阈值容忍（R5 命中）。改用 `--surface`（大面积可见）验证，符合 R5 预案。

## 机制说明

- **渲染环境**：visual-chromium project 用真实 chromium（`chromium.launch`），不走 happy-dom（var() 展开一致性，S1 W1 R1）
- **vite dev server**：由 `e2e/visual/fixtures/visual-server.ts` 的 worker-scoped auto fixture `visualBaseURL` 管理——spawn `packages/renderer` vite（`VITE_MOCK=true`，端口 findFreePort(1430)），worker 结束自动 kill。复用 W1/W2 的 spawnVite 范式（findFreePort + --no-strictPort + PATH 注入 + pollReady + killProcess）
- **不用全局 webServer**：避免 visual 的 vite 依赖拖累 electron project（design-review TO1）。fixture 仅 visual-chromium project 经 testMatch 使用
- **mock 模式**：`VITE_MOCK=true` 让 renderer 自洽渲染（mockApi + connection mock），不走 transport/ws-client/runtime。session list 是 `fixtureSessions`（5 个，不含 e2eTestSession——后者需 `VITE_E2E=true` 构建）
- **snapshotPathTemplate**：`{snapshotDir}/{testFileBaseName}/{arg}{ext}`，按 spec 文件名自动分目录（shell.spec.ts → `shell.spec/`）
