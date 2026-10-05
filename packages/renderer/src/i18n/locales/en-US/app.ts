export default {
  title: 'TaiJi',
  waiting: 'Waiting for Runtime…',
  greetingMorning: 'Good morning',
  greetingAfternoon: 'Good afternoon',
  greetingEvening: 'Good evening',
  greetingPrompt: 'What can I help you with?',
  // shared dismiss aria-label (memory pressure bar and other dismiss buttons)
  crashDismiss: 'Dismiss',
  // RD-3#11 memory pressure notice bar (useMemoryPressure level → UI consumer)
  memoryPressureWarn: 'High memory usage; some caches were cleared automatically',
  memoryPressureCritical: 'Memory critically low; consider closing some sessions',
  // App bootstrap failure (useSidebar.initApp catch): recovery action = reload the page
  bootstrapFailed: 'App initialization failed: {msg}. Reload the page to retry',
}
