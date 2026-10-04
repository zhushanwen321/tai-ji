export default {
  title: 'TaiJi',
  waiting: 'Waiting for Runtime…',
  greetingMorning: 'Good morning',
  greetingAfternoon: 'Good afternoon',
  greetingEvening: 'Good evening',
  greetingPrompt: 'What can I help you with?',
  // T2: one-shot crash recovery notice bar (wording from design T2)
  crashRecovered: 'Recovered from a crash (reason: {reason}). Your session data is safe.',
  crashReasonOom: 'out of memory',
  crashReasonUnknown: 'unknown',
  crashDismiss: 'Dismiss',
  // RD-3#11 memory pressure notice bar (useMemoryPressure level → UI consumer)
  memoryPressureWarn: 'High memory usage; some caches were cleared automatically',
  memoryPressureCritical: 'Memory critically low; consider closing some sessions',
}
