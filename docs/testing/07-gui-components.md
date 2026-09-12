# 07 · GUI 组件渲染

> extension 通过 GUI 渲染协议推送结构化内容块（`GuiComponent`），前端 `GuiComponentRenderer` 按 `type` 路由到对应 Vue 组件渲染。本手册覆盖 7 种 block type 的单测 + 两条渲染路径的 E2E 验证。
>
> 协议定义见 `packages/extension-protocol/src/core/types.ts`，helper 见 `helpers.ts`。

## 1. 组件与 testid 清单

所有 GUI 组件位于 `packages/ui/src/rendering-protocol/`：路由器 `GuiComponentRenderer.vue` + `primitives/` 下按 type 路由的纯展示组件。testid 以组件 template 内 data-testid 属性为准（下表均已核实有效）。

| testid | 组件 | 所在文件 |
|---|---|---|
| `gui-component-renderer` | GuiComponentRenderer（路由器外壳） | `rendering-protocol/GuiComponentRenderer.vue` |
| `ansi-text` | AnsiText | `rendering-protocol/primitives/AnsiText.vue` |
| `gui-progress-bar` | ProgressBar | `rendering-protocol/primitives/ProgressBar.vue` |
| `gui-stats-line` | StatsLine | `rendering-protocol/primitives/StatsLine.vue` |
| `gui-tab-bar` | TabBar | `rendering-protocol/primitives/TabBar.vue` |
| `gui-card` | Card | `rendering-protocol/primitives/Card.vue` |
| `gui-columns` | Columns | `rendering-protocol/primitives/Columns.vue` |
| `gui-list-tree` | ListTree | `rendering-protocol/primitives/ListTree.vue` |
| `tool-block-header` | Block tool 块 header（点击展开） | `features/chat/Block.vue` |
| `drawer-tab-{key}` | DrawerPanel tab 按钮（key=terminal/browser/git/doc/detail） | `features/drawer/DrawerPanel.vue` |

## 2. 渲染路径概述

两条渲染路径都收敛到 `GuiComponentRenderer` 按 `BUILTIN_MAP[type]` 路由到具体 primitive 组件：

- **路径 B（消息流）**：extension tool 返回 `details.__gui__` → runtime event-adapter 随 `message.tool_call_end` 下发 → 前端把 details 存入 toolCall → `Block.vue` 的 guiComponent computed 提取组件 → GuiComponentRenderer 渲染。
- **路径 A（SideDrawer widget）**：extension 调 `ctx.ui.setWidget(key, [NUL_MARKER + JSON])` → runtime event-adapter 检测 marker、JSON.parse 并 isGuiComponent 校验 → 以 `extension:widgetGui` 帧下发 → 前端 dispatchSession 后由抽屉容器消费，按 widgetKey 挂到对应 tab → GuiComponentRenderer 渲染。

Mock 模式跳过 runtime event-adapter：`run-send-stream.ts` 直接 `pushSession` 推已解码的 `extension:widgetGui`。

## 3. MOCK 测试（vitest 单测）

单测统一在 `packages/ui/src/rendering-protocol/__tests__/`（GuiComponentRenderer + 各 primitive + PrimitiveRouter），覆盖 7 种 type 的组件级渲染 + 边界条件（递归/嵌套/depth/status 映射/降级）。以目录内实际测试文件为准。

运行：`cd packages/ui && npx vitest run src/rendering-protocol/__tests__/`

## 4. Playwright E2E 测试

**Spec 文件**：`e2e/gui-components.spec.ts`（已落地）

### 4.1 公共前置

- Mock 轨：`VITE_MOCK=true` + `XYZ_MOCK=1`（launch-app fixture 自动设置）
- 使用 `e2e-files` session（有文件树 + 可发消息）
- mock `run-send-stream` 推送序列含 `tool_call_end(details.__gui__)` + `extension:widgetGui × 2`

### 4.2 用例

| ID | 场景 | 关键断言 |
|---|---|---|
| E2E-GUI-1 | harness smoke | app 加载首窗口 + sidebar 会话按钮可见 |
| E2E-GUI-2 | 路径 B: tool result `__gui__` → card 嵌套渲染 | `gui-card` + `gui-progress-bar` + `gui-stats-line` 可见，含 'CI Pipeline'/'build'/'7'/'8'/'turns'/'15' |
| E2E-GUI-3 | 路径 A: widgetGui stats-line → terminal tab | `gui-stats-line` 在 SideDrawer 内可见，含 'turns'/'tokens'/'duration' |
| E2E-GUI-4 | 路径 A: widgetGui list-tree → browser tab | `gui-list-tree` 在 SideDrawer 内可见，含 'Deploy'/'VPC'/'RDS'/'Redis' |

### 4.3 每步期望输入输出

#### E2E-GUI-2: 路径 B（tool result __gui__）

| 步骤 | 操作 | 期望 |
|---|---|---|
| 1 | 激活 s3 session（'API 性能优化'） | `composer-box` 可见 |
| 2 | 输入 'GUI 测试' + Enter | stop-btn 出现 → 消失（流式完成） |
| 3 | 点击 `.turn-meta` | 展开 turn trace（完成后默认收起） |
| 4 | 点击 `tool-block-header` | tool 块展开 |
| 5 | 断言 `gui-card` | 可见，含 'CI Pipeline' |
| 6 | 断言 `gui-progress-bar` | 可见，含 'build' '7' '8' |
| 7 | 断言 `gui-stats-line` | 可见，含 'turns' '15' |

#### E2E-GUI-3: 路径 A（widgetGui stats-line）

| 步骤 | 操作 | 期望 |
|---|---|---|
| 1-2 | 同 E2E-GUI-2 | 流式完成 |
| 3 | 点 `drawer-toggle` | SideDrawer 打开（默认 terminal tab） |
| 4 | 断言 SideDrawer 内 `gui-stats-line` | 可见，含 'turns' 'tokens' 'duration' |

#### E2E-GUI-4: 路径 A（widgetGui list-tree）

| 步骤 | 操作 | 期望 |
|---|---|---|
| 1-2 | 同 E2E-GUI-2 | 流式完成 |
| 3 | 点 `drawer-toggle` | SideDrawer 打开 |
| 4 | 点 `drawer-tab-browser` | 切到 browser tab |
| 5 | 断言 SideDrawer 内 `gui-list-tree` | 可见，含 'Deploy' 'VPC' 'RDS' 'Redis' |

### 4.4 运行命令

```bash
pnpm run build:e2e                              # 构建 E2E 产物
npx playwright test e2e/gui-components.spec.ts # 只跑 GUI 组件 E2E
npx playwright test                            # 跑全部 E2E
```

## 5. 已知约束

- **SideDrawer 打开方式**：通过 PanelHeader 的 `drawer-toggle` 按钮打开（always-visible，不依赖 git 仓库）。默认显示 terminal tab。
- **widgetGui 是瞬态的**：不持久化到 message store，session 切换 / 组件卸载后清除。只有 tool result `__gui__` 在历史重放后仍存在。
- **Card/Columns 递归**：通过 `<GuiComponentRenderer v-for :component>` 中转递归，不自己处理 type 路由。
- **ListTree 自递归**：`<ListTree :items="children" :depth="depth+1">` Vue 组件自递归渲染子节点，depth 自动 +1 传递缩进。
