# taiji 插件体系文档

插件化是 taiji 的架构主线之一。「扩展点」在本项目里有两个不通用层，先读区分表再进具体文档。

## 阅读顺序

| 顺序 | 文档 | 回答什么 | 什么时候读 |
|---|---|---|---|
| 1 | [architecture.md](architecture.md) | 插件架构长什么样：四层模型、贡献点契约、生命周期、数据流、与 pi extension 的分工边界、已知缺口 | 改插件系统 / 设计新扩展点 / 判断某能力该由谁承载 |
| 2 | [extension-points.md](extension-points.md) | 现在到底能扩展哪些位置：renderer / runtime / pi extension 三层逐点清单（契约 + 注册机制 + 消费方 + 实装状态） | 动手前查「这个位置能不能插」/ 评估插件化改造范围 |
| 3 | [built-in-plugin-guide.md](built-in-plugin-guide.md) | 怎么写一个插件：目录结构、manifest 字段、API 逐方法说明、最佳实践 | 实际写代码时 |

## 改造分析（一次性产物）

| 文档 | 内容 |
|---|---|
| [renderer-pluginization-scan.md](renderer-pluginization-scan.md) | Renderer 层固定实现 → 插件化的扫描报告：24 个候选（A/B/C/D 分档）+ 依赖关系 + 落地批次建议 + 待裁决问题 |

## 两层「扩展」的判别（最高频误判源）

| | **taiji Plugin** | **pi extension** |
|---|---|---|
| 跑在哪 | runtime 托管的 Worker / fork 子进程 | pi 子进程内（每 session 一个） |
| 解决什么 | UI 贡献、后台常驻服务、provider 来源、命令声明 | 模型可见能力：tool / slash 命令执行 / 消息渲染 / provider 注册 / pi 事件钩子 |
| 契约 | `packages/plugin-sdk/src/types.ts` | `@earendil-works/pi-coding-agent` 的 `ExtensionAPI` |
| 能渲染 UI 吗 | 能（`GuiComponent` 树经 ViewHost） | 只能经 pi 通道投递（marker / widget / tool details） |

**判据**：能力要出现在**模型眼前**（tool / 命令 / 上下文）→ pi extension；要出现在**屏幕上**或**常驻后台** → taiji plugin。两者可配对（羊毛 provider = 插件做管理 UI + pi 扩展做协议转换的双产物）。

## 相关文档（体系外）

- [../architecture/extension-gui-protocol.md](../architecture/extension-gui-protocol.md)——GuiComponent 渲染协议（marker 通道 / 原语清单 / 挂载现状）
- [../architecture/renderer-package-topology.md](../architecture/renderer-package-topology.md)——renderer 包拓扑与 ExtensionHost 分层（§4）
- [../extensions/development-guide.md](../extensions/development-guide.md)——pi extension 开发指南
- [../extensions/extension-conventions.md](../extensions/extension-conventions.md)——pi extension 强约束（目录分组 / `taiji.role`）
- [../extensions/gui-protocol-guide.md](../extensions/gui-protocol-guide.md)——pi extension 接入 GUI 的操作指南
