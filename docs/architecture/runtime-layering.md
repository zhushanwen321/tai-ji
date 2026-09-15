# Runtime 三层分层（SSOT）

> **状态**：runtime 分层现行 SSOT——三层边界规则 + ports 依赖倒置 + services→infra 受控例外登记（活跃文档，新增例外在此登记）。2026-06 迁移期的 67 文件归位表与 R0–R5 分阶段步骤已删除（git 可追溯；迁移已完成）。原文件名 `runtime-layering.md`，2026-09-13 改名。适用范围：`packages/runtime/`（Main 进程不在范围）；plugin-service 自洽黑盒保留在 services/。
>
> **取代关系**：取代 design.md D4 的「transport/services/adapters/infra 四层」。工程入口速查见根 [ARCHITECTURE.md](../../ARCHITECTURE.md)；模块与接口落点见 [context.md](context.md)「Agent Runtime」词条。

---

## 1. 决策：为什么三层 + ports 依赖倒置

runtime 是 pi 引擎的 Node.js 宿主 + 协议适配层，**领域逻辑非常薄**（真正 AI 业务规则在 pi 进程内部）——provider/skill/agent CRUD 是纯转发、格式映射是翻译不是规则、多数「逻辑」是编排不变量。强行做 Clean Architecture 的 domain 层会退化成「把 service 方法签名抄一遍」的空壳。

### 为什么放弃 design.md D4 的四层（transport/services/adapters/infra）

D4 本意是区分「怎么连外部系统」(infra) 与「怎么翻译外部格式」(adapters)，实证暴露 3 个问题：

| 问题 | 证据 |
|------|------|
| **adapters 名存实亡** | pi-config-bridge 是 pi 模块的聚合 re-export，不是翻译层；翻译职责漏到 service |
| **PiXxx 类型四处泄漏** | 根级 types.ts 全是 `Pi*` 类型；config/session/tree-service 直接吃 Pi 类型 |
| **infra 反依赖 adapters** | infra/rpc-client import adapters/pi-config-bridge——四层声称的单向依赖不成立 |

**根因**：pi 的「路径配置」与「协议传输」被切到不同层，但后者需要前者，adapters 退化成「公共工具层」。

### 终态：方案 C——三层 + ports 依赖倒置

```
transport/  ← 协议入口：server + router + handlers（纯路由，零业务）
services/   ← 业务编排：定义 ports（依赖接口），零 infra 直连
infra/      ← pi/外部系统适配：实现 ports；连接 + 翻译合并；PiXxx 类型仅在此层
```

C 一次解决三个问题：adapters/infra 边界不再存在；ports 接口用内部类型签名，service 摸不到 PiXxx；没有 adapters，infra 是最底层。D4 仍生效的部分全部保留：transport 纯路由、services 按域切、session 拆分（lifecycle/dispatcher/scanner）、plugin-service 自治切片。

**依赖方向**：`transport → services ← infra`（services 定义 ports，infra 实现 ports，箭头都指向接口）。**无环**。

### 现行结构速览

```
packages/runtime/src/
├── index.ts          # 组合根（DI 接线 + 信号）
├── interfaces.ts     # service → transport 契约（ISessionService 等）
├── transport/        # server / router / handlers/
├── services/         # session/ config/ model/ git/ terminal/ quota/ ... + plugin-service/（黑盒）
│   └── ports/        # ★ 依赖倒置载体：pi-engine / config / model / installer / git-* / workspace 等
└── infra/            # pi/（rpc-client、process-manager、event-adapter、message-converter、session-store）
                      # relay/ git/ fs/ installers/ system/ logger crash-journal mem-pressure watchdog ...
```

> 命名注记：设计期曾用 pi-client/process-pool 等目标名，实际落地保留 `infra/pi/rpc-client.ts` / `process-manager.ts` 原名（实现 IPiEngine / IProcessManager）。

---

## 2. 三层边界规则

| 层 | 可依赖 | 禁止 | 核心约束 |
|----|--------|------|---------|
| **transport** | services(接口) + shared | 不碰 node: 内置；不做业务决策 | 纯路由：参数提取→调 service→组装响应 |
| **services** | ports(自己定义的接口) + shared + 内部类型 | **不 import infra**（受控例外见 §3）；**不出现 PiXxx 类型** | 业务编排，经 ports 访问外部能力 |
| **infra** | 外部系统 + node: 内置 + shared | 不知道 WS 协议；不知道 session 业务语义 | 实现 ports；**PiXxx 类型仅在此层内部** |

机器防线：`.githooks/check_services_infra_import.py` 拦截 services→infra 方向的 value import（白名单与基线模块清单见该脚本 docstring；约束登记 C-comm-03）。

---

## 3. 跨切面例外（受控违背「services 不 import infra」）

两类模块可不经 port 直接静态依赖 infra：**logger 类横切关注点**（无业务语义、process-wide 单例）与 **kernel 类纯函数**（无状态、无副作用、无 IO，与 shared 同性质）。为它们定义 port 并注入只会复制无意义间接层。**新增 services→infra import 时的判断准则**：符合上述两类可直接 import 并在本节登记；其余 infra 模块（pi 协议类型、RPC 子进程、有状态/有 IO 的文件操作、安装器）一律经 port。

| # | 模块 | 性质 | services 层消费方 |
|---|------|------|------------------|
| ① | `infra/logger.ts` | 全局日志落盘 + 轮转 + console monkey-patch（terminal-tee），纯横切单例 | quota 族 / migration / worktree-config-helper 等 8 处 |
| ② | `infra/pi/pi-paths.ts` | kernel 纯路径函数（getSessionsDir/getPiAgentDir/encodeCwd 等，无 IO） | config / extension / session 族 6 处 |
| ③ | `infra/git/git-status-parser.ts` + `infra/fs/ignore-parser.ts` | kernel 纯解析/匹配函数 | git-service / file-service |
| ③b | `infra/crash-journal.ts` | 崩溃台账 writer（append-only JSONL + 轮转，best-effort），logger 同类横切 | 死亡/自愈决策点双写台账行 |
| ③c | `infra/mem-pressure.ts` | os 级内存压力即时查询（无状态只读，永不 reject） | startup-reattach（watchdog 链） |

### ④ node:fs 直用——基线债登记（非合规例外）

services 层存量生产文件 value import `node:fs`（实测 45+ 处），与 C-comm-03 目标态存在长期差距——**是未收编的基线债，不是合规形态**。已显式列入清单的代表性文件：`background-task-reaper.ts`、`startup-reattach.ts`、`runtime-checkpoint.ts`、`rolling-restart.ts`（v8 heap 探针，os 只读同类）。判定理由与收编路线：新增 services 代码优先经 port 访问文件系统；存量随 ports 收编统一迁移；迁移完成前，本登记作为架构审查对该形态的豁免依据（防误报为「新增违规」）。逐文件裁决记录 git 可追溯。

---

## 4. ports 接口清单（依赖倒置的载体）

ports 是 services 定义「我需要什么能力」、infra 实现的契约。**实际落点 = `services/ports/` 目录**（pi-engine / config / model / installer / git-executor / git-info / file-change-diff / extension-settings / workspace 等 19 个接口文件），接口签名只用内部类型或 shared 类型，绝不出现 PiXxx。

代表接口（完整定义以 ports/ 目录为准）：

- `IPiEngine`（ports/pi-engine.ts）：pi 引擎交互——prompt/abort/steer/followUp/compact/setModel/getHistory 等；`sendCommand/sendRaw` 逃生口已删除（响应归一下沉）。
- `IProcessManager`：pi 进程池——createSession/destroySession/getClient/onExit。
- `IConfigStore` / `IModelSource` / `IInstaller`：Provider/Skill/Agent CRUD、模型发现、npm/git 安装。

**与 interfaces.ts 的分工**：`interfaces.ts` 是 service 对 transport 暴露的契约（ISessionService 等）；ports 是反方向的——service 对 infra 要求的能力契约。两者并存不冲突。

**内部事件类型**：service 只见翻译后的内部事件（`PiTranslatedEvent` 等），由 infra/pi/event-adapter 从 pi 原始事件翻译而来——这是「断开 PiXxx 泄漏」的关键。

---

## 5. 验证口径（收尾检查）

- `rg "Pi[A-Z]" services/ transport/` → 应为空（PiXxx 不泄漏出 infra）
- `rg "from '.*infra/" services/` → 仅 §3 登记的受控例外（机器防线 check_services_infra_import.py）
- `pnpm run build:runtime` + `bash scripts/validate-runtime-bundle.sh` + vitest

---

## 一句话总结

runtime 是 pi 引擎的 Node.js 宿主，领域薄、适配重：三层（transport/services/infra）+ ports 依赖倒置断开 PiXxx 泄漏，横切关注点与 kernel 纯函数是仅有的 services→infra 直连例外且须本文件登记。
