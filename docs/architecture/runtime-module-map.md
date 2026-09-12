# Runtime 模块架构图

**关联**：[runtime-three-layer-design.md](runtime-three-layer-design.md)（设计原理）· [runtime-migration-progress.md](runtime-migration-progress.md)（R0–R9 迁移记录）
**快照时点**：R9 后（三层迁移 + 例外清理 + ports 按域拆分完结）；文件数/行数于 **2026-09-12 重数**（口径：`find ... -name '*.ts'` 剔除 `__tests__/` 与 `*.test.ts` 的生产代码）

---

## 分层骨架

```
                    runtime/src/   (269 .ts · 63537 行 · Electron 子进程)
══════════════════════════════════════════════════════════════════════════════════════

    ┌──────────────────────────────────────────────────────────────────────────┐
    │              @xyz-agent/shared   (sibling package)                         │
    │   ClientMessage · ServerMessage · Message · ProviderInfo · ModelInfo ...  │
    └────────────────────────────────┬─────────────────────────────────────────┘
                                     │ 协议类型，所有层 import
    ┌────────────────────────────────┴─────────────────────────────────────────┐
    │  index.ts  ── 组合根（唯一知道所有具体类的位置）                            │
    │  构造 infra 实现 → 构造 services → wire(setServices) → server.start()     │
    └──────┬────────────────────────────────────┬──────────────────────┬───────┘
           │                                    │                      │
           ▼                                    ▼                      ▼
  ╔════════════════════╗              ╔════════════════════════╗    ╔════════════════════╗
  ║   transport/       ║   调用       ║      services/         ║    ║      infra/        ║
  ║   路由·连接·广播    ║─────────────→║   业务逻辑 + ports 定义 ║    ║   外部系统连接器    ║
  ║  21 files · 5031行 ║   IService   ║  179 files · 42016行 ║    ║  50 files·13185行 ║
  ╚════════════════════╝   接口       ╚════════════╤═══════════╝    ╚════════╤═══════════╝
                                        │                          │        │
                                        │    services 定义 ports/   │        │
                                        │◄──── 依赖倒置契约 ───────►│        │
                                        │   infra 实现这些接口      │        │
                                        │                          │        │
                                        ▼                          │        │
                              ╔════════════════════╗               │        │
                              ║  services/ports/   ║               │        │
                              ║  6 域 port 接口(R9) ║               │        │
                              ║ config · session   ║               │        │
                              ║ pi-engine · model  ║               │        │
                              ║ installer · tree   ║               │        │
                              ╚════════════════════╝               │        │
                                                                   │        │
                              services ──✕──→ infra（零直连，R5/R7）│        │
                              经 ports/ 接口访问 ──────────────────────────→│
                                                                   │        │
                                                                   ▼        ▼
```

- **transport/**（21 files · 5031 行）：路由 ClientMessage → service 调用，管理 WS 连接，广播 ServerMessage。零业务逻辑。
- **services/**（179 files · 42016 行）：业务逻辑，定义 ports/ 接口。**零 infra 直连**（R5/R7 达成）。
- **infra/**（50 files · 13185 行）：外部系统连接器（design.md T4：唯一与 pi/npm/git/HTTP 打交道的位置），实现 ports/ 接口。

---

## services/ 内部模块

```
╔═══════════════════════════════════════════════════════════════════════════════════
║  services/ 内部
║
║  顶层 5 service:
║  ┌────────────┐ ┌──────────┐ ┌──────────┐ ┌────────────────┐ ┌────────────┐
║  │ConfigService│ │ModelSvc  │ │TreeSvc   │ │ExtensionService│ │SessionSvc  │
║  │ IConfigStore│ │IModelSrc │ │ITreeRead │ │ IInstaller     │ │ Facade(9依赖)│
║  └────────────┘ └──────────┘ └──────────┘ │ IExtensionReslv│ │ ISessionStore│
║                                            └────────────────┘ └──────┬─────┘
║  子目录:                                                        组合 3 子模块:
║  services/session/  (Lifecycle·Dispatcher·Scanner，经 ISessionServiceInternal 接口)
║    + subagent 读链：subagent-engine-history.ts（协议客户端①级读——三级发现装载
║      cli descriptor 后按需 spawn 引擎 CLI 调协议 read，idle 5min dispose）
║      · subagent-extractor.ts · subagent-status.ts（engine-protocolization §3.6 + D9）
║  services/scanners/ (skill·agent·base —— R6 从 infra 归位，纯 fs 非 pi 协议)
║  services/plugin-service/  ◄── 见下方独立切片
╚═══════════════════════════════════════════════════════════════════════════════════
```

**SessionService** 是 Facade：9 依赖（7 port + 1 闭包 + 1 配置），持有 sessions Map（单写者），组合 SessionLifecycle/MessageDispatcher/SessionScanner 三子模块。子模块经 `ISessionServiceInternal` 公共接口访问 Facade（依赖倒置，非半构造——见 migration-progress R9 评估）。

---

## infra/ 内部模块

```
╔═══════════════════════════════════════════════════════════════════════════════════
║  infra/ 内部（design.md T4：唯一与外部系统打交道的位置）
║
║  infra/pi/  (14 files · pi 引擎连接)
║  ┌──────────┐┌────────────┐┌────────────┐┌──────────────┐┌──────────────┐
║  │RpcClient ││ProcessMgr  ││EventAdapter││PiConfigStore ││PiSessionStore│
║  │IPiEngine ││IPiProcess  ││pi→WS翻译   ││IConfigStore  ││ISessionStore │
║  └──────────┘└────────────┘└(511行)─────┘└──────────────┘└──────────────┘
║  + session-tree-reader(ITreeReader)·navigate-interceptor(Factory)·pi-config-bridge
║    ·pi-protocol(388行)·pi-provider-store·pi-paths·message-converter
║
║  infra/relay/  (5 files · 宿主侧 relay 通道——engine-protocolization v5 R4)
║  relay-server·relay-registry·relay-tee·relay-env·relay-paths
║    （tee 引擎 CLI 输出转发宿主；父身份键 SESSION_ID/RECORD_ID 剥除覆写防误归属）
║
║  infra/installers/   infra/顶层        infra/system/
║  NpmGitInstaller    ModelApiDiscoverer  trash
║  (IInstaller)       (IModelSource)
╚═══════════════════════════════════════════════════════════════════════════════════
```

每个 infra 模块实现一个 port：RpcClient→IPiEngine，ProcessManager→IPiProcess，PiConfigStore→IConfigStore，PiSessionStore→ISessionStore，NpmGitInstaller→IInstaller，ExtensionResolver→IExtensionResolver，ModelApiDiscoverer→IModelSource，SessionTreeReaderAdapter→ITreeReader，NavigateInterceptorFactory→INavigateInterceptorFactory（共 9 个 port 实现）。

---

## plugin-service/ 纵向切片

```
╔═══════════════════════════════════════════════════════════════════════════════════
║  services/plugin-service/  ◄── 纵向切片（design.md T5：自治，27 files · 6908行 = 49%）
║  对外只暴露 IPluginService + index.ts；内部自组织，不强制对齐全局层
║  PluginService(640·Facade)·PluginHost(470·Worker池)·PluginActivator(597·状态机)
║  ·PluginRegistry·plugin-rpc·sandbox·storage·hook-api·session-data·api/*
╚═══════════════════════════════════════════════════════════════════════════════════
```

占 runtime 49% 代码量。configDir 经组合根注入（R7），切片内部不再直连 infra。

---

## utils/ + 顶层契约

```
╔═══════════════════════════════════════════════════════════════════════════════════
║  utils/  ◄── 跨层共享叶子层（R6 确立，零业务语义，所有层可 import，不依赖业务层）
║  fs-utils(atomicWrite)·path-utils(isStrictlyUnder)
║  ── 顶层文件 ──
║  interfaces.ts (10 接口 · IService/IMessageBroker/IProcessManager 契约枢纽)
║  types.ts (TreeNode/TreeData/NavigateResult 内部类型)
╚═══════════════════════════════════════════════════════════════════════════════════
```

`utils/` 是三层架构的第四个层——不是业务层，是所有业务层的公共底座（无业务语义的纯工具）。`interfaces.ts` 定义跨层服务契约（IService*），`services/ports/` 定义依赖倒置契约（IPort*），两者分工：interfaces 是"service 对外能力"，ports 是"service 需要的外部能力"。

---

## 依赖铁律

```
  transport ──→ services          (调 IService 接口)
  services  定义 ports/           (依赖倒置契约)
  infra     实现 ports/           (唯一连外部系统)
  services ──✕──→ infra           (零直连，R5/R7 达成)
  所有层 ──→ utils · @xyz-agent/shared   (叶子底座，不依赖任何业务层)
```
