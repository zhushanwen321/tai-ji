# @zhushanwen/session-delivery

Session 消息投递内核：零 pi 依赖的策略层，负责排队、合批、去重与 gated flush。

## 设计原则

- **零 pi 依赖**：内核不 import pi 包任何符号。steer/followUp/triggerTurn/streamingBehavior 等 pi 词汇封闭在两侧适配器内。
- **端口注入**：`DeliveryPort` 是内核与外部世界的唯一接口（isIdle / hasPendingMessages / send / subscribeSettled），调用方负责注入运行时能力。
- **意图驱动**：调用方声明投递意图（`DeliveryIntent`），内核处理与目标 session 运行状态的冲突。intent → pi 参数的翻译在适配器内。

## 接口

```ts
import { createDelivery, type DeliveryHandle, type DeliveryPort, type DeliveryConfig } from '@zhushanwen/session-delivery'

const handle = createDelivery(port, config)

// 常规入口：入队 + 合批/去重/gated flush
handle.send({ payload: { kind: 'text', content: 'hello' } })

// 同步确认变体：入队 + 可达性确认
await handle.sendChecked({ payload: { kind: 'text', content: 'hello' } })

// 强制投递（shutdown / park 外部重触发 / settled 边沿内部复用）
handle.flush()

// 队列深度（诊断/测试）
handle.depth()

// 销毁（清空队列 + 清 timer）
handle.dispose()
```

## 策略默认值

| 策略 | 默认值 | 说明 |
|------|--------|------|
| `intent` | `'interrupt-at-turn-boundary'` | turn 边界抢占（F1 教训内化） |
| `busyPolicy` | `'retry-force'` | settled 边沿驱动 flush + watch-dog 30s 复核；无订阅装配退化退避 {100ms, 50}≈5s 后强制发送 |
| `mergeWindowMs` | `0` | 关；显式设值启用滑动窗口合批 |
| `backoff` | `{ ms: 100, max: 50 }` | 退避参数 |
| `watchdogMs` | `30_000` | watch-dog 复核间隔 |

## 约束

- **同 session 单例 handle**：多 handle 并发投递竞态无保护。runtime 装配层必须以 sessionId 为键做单例注册表；extension 侧同理。
- **subscribeSettled 的退订语义由适配器负责兑现**。pi.on 返回 void 且无 off，适配器需用 disposed 标志包装。

## 开发

```bash
cd packages/session-delivery
npx vitest run        # 跑测试
npx tsc --noEmit      # 类型检查
```
