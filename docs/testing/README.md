# 测试手册（Testing Handbook）

> 各页面/组件的**具体测试步骤**：MOCK 模式如何测、非 MOCK 模式如何测、Playwright E2E 如何调用、每一步期望什么输入输出。
>
> 本手册是 [TEST-STRATEGY.md](../../TEST-STRATEGY.md)（根 SSOT，测试分层/框架规则）的**操作落地篇**——策略讲「为什么这么分层」，本手册讲「具体怎么测某个功能」。

## 文档索引

| 文档 | 功能 | MOCK 测试 | 非 MOCK 测试 | Playwright E2E |
|------|------|----------|-------------|----------------|
| [00-test-strategy-overview.md](./00-test-strategy-overview.md) | 测试流程总览（双轨制 / harness / 公共前置） | — | — | — |
| [01-new-task.md](./01-new-task.md) | 新建任务（Landing + 选目录 + 首发提交） | ✅ | ✅ | ⚠️ 范例（未落地 spec） |
| [02-composer.md](./02-composer.md) | Composer（输入框 + slash 命令浮层 + 三态） | ✅ | ⚠️ | ✅ **已落地**（`e2e/composer.spec.ts`） |
| [03-chat-flow.md](./03-chat-flow.md) | 对话流（流式消息 + 工具调用 + 变更集） | ✅ | ✅ | ⚠️ 范例（文本锚点可跑，未落地 spec） |
| [04-file-tree.md](./04-file-tree.md) | 文件树（懒加载 + 过滤 + git 角标） | ✅ | ✅ | ✅ **已落地** |
| [05-side-drawer.md](./05-side-drawer.md) | SideDrawer（文件预览 / diff / git tab） | ✅ | ✅ | ✅ 范例（detail + git tab 有可跑断言） |
| [06-search-modal.md](./06-search-modal.md) | 搜索浮层（⌘K 四类分组 + 跳转 + loading·error） | ✅ | ✅ | ✅ **已落地**（`e2e/search-modal.spec.ts`） |
| [07-gui-components.md](./07-gui-components.md) | GUI 组件渲染（7 种 block type + 两条渲染路径） | ✅ | — | ✅ **已落地** |
| [08-real-track-manual.md](./08-real-track-manual.md) | real 轨手工测试（给 ai-agent 照着执行） | — | ✅ | — |
| [09-subagent-workflow-panel.md](./09-subagent-workflow-panel.md) | Subagent/Workflow 面板（Agents/Flows tab + subagent 对话流切换） | ✅ | ⚠️ real-track CDP | ⚠️ 手工 CDP（mock 返回空，real-track 手工冒烟） |
| [10-settings-system-prompt.md](./10-settings-system-prompt.md) | 系统提示词配置（替换 pi 核心 / 追加注入） | ✅ | ✅ | — |
| [11-real-e2e-specs.md](./11-real-e2e-specs.md) | real 轨 E2E 自动化 spec（真 Electron + runtime + pi + LLM，零 mock） | — | ✅ | ✅ **已落地** |
| [12-extension-runtime-testing.md](./12-extension-runtime-testing.md) | extension 层运行时测试体系（价值层级 + 决策树；L1 harness 已随重构移除，见文头 STALE 注） | — | ✅ | ⚠️（仅 real spec 留存） |
| [13-plugin-e2e.md](./13-plugin-e2e.md) | 插件系统非 mock 端到端验收基线（verify-plugin-e2e.sh） | — | ✅ | — |
| [14-background-task-sidebar.md](./14-background-task-sidebar.md) | 后台命令侧边栏视图 + drawer 详情（三桶筛选 + 行内终止 + 输出跟随） | ✅（vitest 组件测试） | ⚠️ real-track 手工 | — |

> 图例：✅ = 可测且稳定 / ⚠️ = 有约束或待补 / ❌ = 不可测（需手工）。
> **已落地** = spec 文件存在于 `e2e/` 且能跑通；**范例** = 文档内有完整可跑代码但尚未落地为 spec 文件。

## 快速导航

**我要测某个功能，从哪开始？**
1. 读 [00-test-strategy-overview.md](./00-test-strategy-overview.md) 理解双轨制（MOCK 轨 / 非 MOCK 轨 / dev 冒烟）和公共前置
2. 找到对应功能文档（01-07、09、10、14），按「MOCK 模式」或「Playwright E2E」章节操作
3. 每个文档都有：组件结构概述 / data-testid 清单 / 每步期望输入输出 / 可复制的测试代码；testid 以组件 template 内 data-testid 属性为准

**我要新增一个功能的测试？**
1. 复制最接近的现有文档作为模板（功能性质相近的）
2. 按统一模板填充：组件清单 → testid 清单 → MOCK 测试 → E2E 测试 → 期望表
3. 更新本 README 索引表

**测试跑挂了？**
- 看 [TEST-STRATEGY.md §2 运行命令](../../TEST-STRATEGY.md) 确认 cwd（renderer 测试必须从 `packages/renderer` 跑）
- 看 [troubleshooting.md](../troubleshooting.md) 排查 runtime/WS/路径问题
- E2E 看 [00-test-strategy-overview.md §6 常见坑](./00-test-strategy-overview.md)
- 单测满载下间歇 flake（等待/删除/跨进程时序）→ [TEST-STRATEGY.md「测试自身引入的 flake 防规范」](../../TEST-STRATEGY.md)
