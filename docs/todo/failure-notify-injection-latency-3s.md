# 失败轮通知注入端到端 ~3s（设计场景 1 承诺 <1s）

状态：待排查（2026-10-24 登记，A1 验收场景两轮实测）。

## 现象

verify-taiji 场景 `p0-subagent-round-failure-facticity`（A1）两轮实测：轮终事实帧（record idle 广播）→ 失败通知帧（`subagent-bg-notify` custom entry 广播）时差 = **3171ms（有负载）/ 3015ms（空载）**——稳定 ~3s，非 CPU 噪音。设计场景 1 通过标准④承诺「应答到达 < 1s（不进攒批窗）」。通知帧内容本身完全正确（五分支文案 + cause 点拼 + 恢复指引，b43554156 修复后）。

## 已排除

- 攒批窗代码：已整机制删除（§3.3.7③，u4 行为锁测试在场）——链上无定时聚合。
- CPU 负载：空载复跑同值。
- 通知文案/判定链：帧内容正确，轮收条事实链（628231633/f0897c308/b43554156 三修）已闭合。

## 时延位置（已定位到链段，未定位到根因）

时延在「record idle 广播 → subagent-bg-notify custom entry 广播」之间：notifier.notify → delivery.send（notify-ports）→ runtime 投递（session-delivery-registry，RECONCILE_MIN_INTERVAL_MS=200 非解释项）→ 父 pi 会话注入 → custom entry 广播。嫌疑焦点 = 父 pi 会话的注入时机（turn boundary 等待？extension 注入通道的轮询/事件粒度？）。

## 排查入口

1. 在注入执行方（delivery-port → pi 侧注入）两端加时间戳探针跑一轮 A1，二分定位 3s 落在哪一跳；
2. 核对父 pi 空闲时 custom entry 注入的触发机制（事件驱动还是 pi 事件循环粒度）；
3. 若确认 pi 上游粒度所致（宿主不可控），按「设计预算修订（附实测依据）」回写场景 1 通过标准，或在设计上把「通知到达」锚定改到宿主侧投递凭证时点（port journal 时间戳）而非 pi 广播时点。

## 现场证据

- A1 第五跑 verdict / summary：`~/.agents/skill-data/dev-flow/<slug>/subagent-observability.verify/a1/`（deltaMs 进 notify.timing step stats）。
