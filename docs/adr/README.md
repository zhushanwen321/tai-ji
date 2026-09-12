# ADR 索引（Architecture Decision Records）

xyz-agent 的架构决策记录。每条 ADR 记录一个不可逆的架构/技术决策：背景、选项、裁决、后果。

## 编号说明

2026-08-02 重构：合并了原 `docs/adr/`（功能/GUI 决策）和 `docs/architecture/adr/`（系统架构决策）两套独立编号体系，按日期统一重编号为 0001-0057。此后新增 ADR 直接顺延编号：0058-0060 为重构后新增（含 Proposed 状态），0061 为 0045 重号消歧（原 `docs/architecture/adr/0045-cw-store-repo-level-keying.md` 与 `docs/adr/0045-self-built-virtual-turn-list.md` 在合并时编号冲突，cw-store 版重编号为 0061）。

**编号唯一性**：磁盘上的 ADR 文件编号与索引一一对应，无重号。

**旧编号查找**：如果从历史 commit/文档看到旧编号引用，按以下映射查找新编号：

| 旧编号 (architecture/adr/) | 新编号 | 旧编号 (docs/adr/) | 新编号 |
|---|---|---|---|
| 0001-0014 | 0001-0014（多数不变） | 0001 | 0032 |
| 0015-0023 | 0015-0023（多数有位移） | 0002-0004 | 0033-0035 |
| 0024-0031 | 0024-0031（不变） | 0033 | 0038 |
| 0032 | 0036 | 0034 | 0040 |
| 0033 | 0037 | 0035 (watchdog) | 0047 |
| 0034-0037 | 0039, 0041-0043 | 0035 (display) | 0048 |
| 0038-0040 | 0044-0046 | 0036-0040 | 0049-0053 |
| 0041-0044 | 0054-0057 | | |
| 0045 (cw-store) | 0061 | | |

> extensions 子系统有独立的 ADR 编号体系（`pi-ext-*`），存放在 `docs/extensions/adr/`，不在本索引范围。

## ADR 清单

| 编号 | 日期 | 标题 |
|---|---|---|
| 0001 | 2026-05-22 | 手动 DI 组装，不引入 IoC 容器 |
| 0002 | 2026-05-22 | SessionPool 整体删除，职责拆分 |
| 0003 | 2026-05-22 | event-adapter translate 不严格绑定 PiEvent 联合类型 |
| 0004 | 2026-05-22 | 配置文件写入采用 write-tmp + rename 原子操作 |
| 0005 | 2026-05-22 | 使用 Bun 编译二进制替代 npm 包 |
| 0006 | 2026-05-22 | 严格打包 pi，无系统回退 |
| 0007 | 2026-05-22 | Git submodule 管理 extension/skill 依赖（被 0011 取代） |
| 0008 | 2026-05-25 | extension-bridge for navigate-tree |
| 0009 | 2026-05-27 | xyz-agent 数据目录与 pi 数据目录完全隔离 |
| 0010 | 2026-05-27 | Extension UI 使用独立事件通道 |
| 0011 | 2026-05-28 | Bundled extensions 直接拷贝（取代 0007 的 submodule） |
| 0012 | 2026-05-28 | Pi Bridge Extension for Plugin Tool Proxy |
| 0013 | 2026-05-28 | sessionData API over pi.appendEntry |
| 0014 | 2026-05-29 | SessionData 本地文件持久化 |
| 0015 | 2026-05-30 | statusline plugin 封装 pi extension setStatus |
| 0016 | 2026-06-05 | Event-bus 类型加固 — 方案 B（约束 ServerMessageType） |
| 0017 | 2026-06-06 | macOS Traffic Light Safe Zone + Sidebar Expand Button（Superseded） |
| 0018 | 2026-06-07 | 使用临时目录处理 Extension Collection 安装 |
| 0019 | 2026-06-18 | 视觉方向收敛到冷蓝暗色 |
| 0020 | 2026-06-18 | 核心 User Flow 范围 |
| 0021 | 2026-06-19 | Agent / Skill 资源加载策略 |
| 0022 | 2026-06-20 | 默认主题方向（暗色冷蓝） |
| 0023 | 2026-06-20 | Overview 入口落点与覆盖范围 |
| 0024 | 2026-06-21 | FileChanges 数据通道（runtime 解析方案） |
| 0025 | 2026-06-28 | File View 语义重定义为全项目文件树 |
| 0026 | 2026-06-28 | 文件树懒加载策略 |
| 0027 | 2026-06-28 | FileService 三层架构 + ignore 纯函数范式 |
| 0028 | 2026-06-30 | 搜索编排归 composable 层（非 domain） |
| 0029 | 2026-06-30 | 领域类型 SSOT 归 lib 层（非 mock） |
| 0030 | 2026-06-30 | 文件匹配算法单一管线复用 |
| 0031 | 2026-07-01 | 跨组件 slash 命令注入用 store 驱动的一次性消息通道 |
| 0032 | 2026-07-02 | thinkingLevelMap key-based 判定 + value 映射 |
| 0033 | 2026-07-03 | recent-workspaces 采用三层架构 |
| 0034 | 2026-07-03 | recent-workspaces 采用 pull-only RPC |
| 0035 | 2026-07-03 | recent-workspaces 持久化复用 write-back + atomicWrite |
| 0036 | 2026-07-04 | Monorepo 结构终态（packages/* + apps/electron + pnpm） |
| 0037 | 2026-07-13 | pi-protocol 深化为真契约 |
| 0038 | 2026-07-15 | Subagent 只支持 cancel，不支持 pause/resume |
| 0039 | 2026-07-16 | chat messages 改用 shallowRef |
| 0040 | 2026-07-16 | 统一 file chip 通道（结构化 file segment） |
| 0041 | 2026-07-16 | isGenerating 改用 computed 派生 Set |
| 0042 | 2026-07-16 | runtime 写 session_end 终态 entry |
| 0043 | 2026-07-16 | Message.content 重构为 Segment[] 结构化模型 |
| 0044 | 2026-07-17 | 系统提示词替换走 pi CLI 核心段，追加走 before_agent_start hook |
| 0045 | 2026-07-17 | 自研按 turn 虚拟滚动（不引入虚拟列表库） |
| 0046 | 2026-07-17 | RPC 类型配对 SSOT（RequestReplyMap + ReplyPayloadMap） |
| 0047 | 2026-07-20 | watchdog 从「事件静默检测」改为「进程健康探测（ping）」 |
| 0048 | 2026-07-21 | 尊重 extension 的 display 字段，删除 HIDDEN_CUSTOM_TYPES |
| 0049 | 2026-07-21 | Session 隔离统一采用 Map 分区派范式 |
| 0050 | 2026-07-21 | landing 态 slash 命令源按 variant 分支 |
| 0051 | 2026-07-21 | 项目级 skill 目录约定为 `.agents/skills` |
| 0052 | 2026-07-23 | Landing 态 isBare 检测改用独立 RPC |
| 0053 | 2026-07-23 | SideDrawer 控制态改为 per-session 分区 |
| 0054 | 2026-07-24 | Browser Drawer 采用 WebContentsView |
| 0055 | 2026-07-29 | MessageBus 架构（per-session ring buffer） |
| 0056 | 2026-07-29 | Composer Staging Mode（暂存模式） |
| 0057 | 2026-07-29 | Composer Staging 策略模式（行为层） |
| 0058 | 2026-08-05 | 新建 @xyz-agent/dom-core 承载 DOM-bound 前端逻辑（Accepted） |
| 0059 | 2026-08-06 | core factory 与 pinia store 集成范式（方法访问 + cast 接缝）（Proposed） |
| 0060 | 2026-08-06 | route-inbound crossSession 通道（全局消费者订阅带 sid 消息）（Proposed） |
| 0061 | 2026-08-06 | cw store 键控基准改为 repo 级（git common dir）（Superseded，被引擎层方案 A 取代） |
| 0062 | 2026-08-19 | 单一数据 owner + 绝对写规则（Accepted） |
| 0063 | 2026-08-19 | session 附着不变量 I1-I5（Accepted） |
| 0064 | 2026-08-28 | pi 语义吸收层四支柱（能力注册表 / 生效回执 / 确认式送达 / 漂移守卫）（Accepted） |
| 0065 | 2026-09-08 | mutation RPC 回复取生效值、禁乐观写（Accepted） |
| 0066 | 2026-08-02 | 视觉色相定为太极·玄纯灰重克制 V3（Accepted；2026-09-13 自 page-design 临时决策文档转正） |
