# 未激活会话投影缓存：首次读早于磁盘事实落定 → 陈旧在途态

状态：待裁决（2026-10-24 登记，a3 验收 §3.3.4 清点场景实测发现；归因级别 = 推断，见下）。

## 现象

宿主重启后，会话**未激活**（pi 未 spawn、extension 未运行）时对 `session.getSubagents` 的首次读取若早于 sweep 补写磁盘事实落定（实测 manifest 的 `completedAt` 比实例就绪晚约 5s），后续读请求持续返回陈旧在途态（`records=[]`）；激活（session.switch）后自愈，未激活态的后续读在清点完成后也可读到正确事实（a3b/a3c 两轮探测 `found=true, count=1`）。

## 推断的机制（源码链路已核，未加探针实证那次失败的具体形态）

`packages/runtime/src/services/session/events-projection.ts` 的 `SessionEventProjection`：投影缓存在首次读请求时建立，`ensureProjection` 的 `cache.projection !== null` 早退只做事件源升级（补源 + 冷读一次），不按磁盘 mtime/水位失效。未激活期间无 journal 推送源（pi 未 spawn），故首次读取落在清点补写帧之前的窗口时，缓存只装载了旧事实。

## 与原则的张力

ADR-0097「查询是真理通道：任何查询必须返回当前真值（缓存优先、磁盘兜底）」——本形态中缓存命中即返回、无磁盘兜底触发点。

## 修向候选（待裁决）

1. 投影缓存命中时按记录目录 mtime / 事件水位做失效判定后再返回；
2. 未激活会话的读请求旁路投影缓存，直接冷读磁盘。

## 影响面

竞态窗口为「实例就绪 → 清点写盘落定」之间的秒级窗口；窗口内读到的陈旧在途态会导致 UI 短暂显示在途、误判占用；窗口外自愈。a3 验收不受阻（清点事实证据走磁盘通道）。

## 附：登记一项实现事实（非缺陷）

wire `lastRound` 刻意不含 `swept`（`events-projection-last-round.ts` 头注裁决）——swept 附注只经 record 事件帧与 extension 工具面 list 条目可达；任何消费方不得依赖 `getSubagents` 拿到 swept。
