<!--
  GenStatsDistributionGrid —— 指标卡内「统计量 × 窗口」分布矩阵（速度卡 / TTFT 卡共用）。

  拆独立组件的动机：速度与 TTFT 两卡的矩阵形态、列头、着色规则完全同构，只差
  「值怎么格式化」（t/s vs ms/s）。复制一份必然漂移（历史上 gen-stats-display 的
  归因文案就是因为存在多份拷贝而漏改过一处）——故矩阵本体单源，量纲经 formatValue 注入。

  形态（2026-10-24 用户裁决）：5 列统计量（平均 / P50 / P99 / 最大 / 最小）× 3 行窗口
  （今日 / 近 7 天 / 近 30 天）。50 个数字铺两列会占掉半屏，5×3 矩阵是信息密度与可读性
  的平衡点：列头只说一次（单位在列头），行头只说一次（窗口名）。

  数值来源 = GenStatsDistribution 五量（runtime summarizeDistribution 算出，renderer 不重算
  ——同一帧的同一份分布值，前端再算一遍只会制造口径分叉）。
  着色：P99 列用 warn 档提示（尾部体感），max 用 danger 档仅在超过阈值时——这里刻意只做
  「P99 是尾部信号」的弱提示，不做逐格语义分档：同一张表里 5 列各自上色会变成彩虹墙，
  反而看不出哪个数字重要。

  契约：props = { rows, columns, formatValue, testidPrefix }（纯展示，无 emits，不触碰数据通道）。
  testidPrefix 让两张卡的矩阵单元格可区分（同一聚合页内两颗矩阵共存，复用同一 testid
  会静默串台——测试断言与真机验收都会读到另一张卡的值）。
-->
<template>
  <div
    class="grid items-baseline gap-x-2 gap-y-1.5 px-2.5 py-2.5"
    :style="{ gridTemplateColumns: `repeat(${columns.length + 1}, minmax(0, 1fr))` }"
  >
    <!-- 角格留空：行头列与列头行的交汇处不放内容 -->
    <span aria-hidden="true" />
    <span
      v-for="col in columns"
      :key="col.key"
      class="text-center font-mono text-[length:var(--text-3xs)] uppercase tracking-[0.05em] text-neutral-dim"
      :title="col.note"
      :data-testid="`${testidPrefix}-column`"
    >{{ col.label }}</span>

    <template v-for="row in rows" :key="row.key">
      <span
        class="font-mono text-[length:var(--text-3xs)] uppercase tracking-[0.05em] text-neutral-dim"
        :data-testid="`${testidPrefix}-row`"
      >{{ row.label }}</span>
      <span
        v-for="col in columns"
        :key="`${row.key}-${col.key}`"
        class="text-center font-sans text-[length:var(--text-2xs)] font-semibold tabular-nums"
        :class="row.values[col.key] == null ? 'text-neutral-dim' : 'text-neutral-fg'"
        :data-testid="`${testidPrefix}-${row.key}-${col.key}`"
      >{{ formatValue(row.values[col.key]) }}</span>
    </template>
  </div>
</template>

<script setup lang="ts">
import type { DistributionColumn, DistributionRow } from './gen-stats-display'

defineProps<{
  rows: DistributionRow[]
  columns: DistributionColumn[]
  /** 数值格式化（含单位处理；null 判定由调用方 formatter 负责，矩阵只负责排版与色档） */
  formatValue: (v: number | null) => string
  /** data-testid 前缀（如 `genstats-speed-dist`；两张卡各用各的，防断言串台） */
  testidPrefix: string
}>()
</script>
