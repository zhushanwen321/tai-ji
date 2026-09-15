<script setup lang="ts">
// App.vue —— mobile 壳四要素布局（DM2）。
//
// 四 zone = message-stream（B 对话流）+ companion（B 伴随）+ slash（D 命令）
// + bottom-tab-bar（壳 chrome，非挂载点）。前三个 zone 对应 §6.3 mobile 挂载点
// 子集（IF1），bottom-tab-bar 是壳自身导航 chrome。
//
// 四 zone 容器的 data-testid（zone-*/bottom-tab-bar）是 AC5 结构断言主锚点；
// zone 内 stub 组件的 data-testid（stub-*）是辅助锚点（DM3）。stub 是 pre-P3/P4
// 占位（slice D1 决议：结构骨架壳，非功能壳），P3/P4 落地后全局 grep 'TODO(Pn)'
// 定位替换为 @taiji/ui 真实组件。
//
// 布局：纵向 flex，message-stream 占主体（flex-1），其余 zone shrink-0 固定。
// 视觉精修属 D1 v6 移动设计 deferred，本 slice 仅结构 + 语义 token 占位。
import MessageStreamStub from './shell/stubs/MessageStreamStub.vue'
import SlashBarStub from './shell/stubs/SlashBarStub.vue'
import CompanionStub from './shell/stubs/CompanionStub.vue'
import BottomTabBarStub from './shell/stubs/BottomTabBarStub.vue'
</script>

<template>
  <div class="mobile-shell flex flex-col h-screen bg-bg" data-testid="mobile-shell">
    <!-- 主内容区：message-stream（B 对话流），flex-1 占主体 -->
    <main class="mobile-shell__main flex-1 overflow-y-auto p-2" data-testid="zone-message-stream">
      <MessageStreamStub />
    </main>

    <!-- companion（B 对话流伴随，mobile 终态抽屉/半屏，本 slice 占位区） -->
    <section
      class="mobile-shell__companion shrink-0 border-t border-[var(--border)] p-2"
      data-testid="zone-companion"
    >
      <CompanionStub />
    </section>

    <!-- slash（D 命令，composer 命令栏） -->
    <div
      class="mobile-shell__slash shrink-0 border-t border-[var(--border)] p-2"
      data-testid="zone-slash"
    >
      <SlashBarStub />
    </div>

    <!-- 底部 tab 导航（壳 chrome，非挂载点） -->
    <nav
      class="mobile-shell__tabbar shrink-0 border-t border-[var(--border)] p-2"
      data-testid="bottom-tab-bar"
    >
      <BottomTabBarStub />
    </nav>
  </div>
</template>
