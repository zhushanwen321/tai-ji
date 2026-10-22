# @zhushanwen/state-machine

## 0.2.0

### Minor Changes

- df839883b: First release of `@zhushanwen/state-machine`: declarative finite state machine infrastructure for pi extensions — literal-typed state/event vocabularies with definition-time self-checks, a pure transition kernel (guards evaluated in order, multi-match throws, planned-vs-applied two-phase actions, `errorPolicy: 'throw' | 'result'`), `coerceState` whitelist mapping, a transactional `runTransition` orchestration shell (actions run in planned order, next state applied only if all succeed), and an exhaustive transition-table test generator.
