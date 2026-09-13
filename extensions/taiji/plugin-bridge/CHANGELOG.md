# @zhushanwen/pi-plugin-bridge

## 0.2.3

### Patch Changes

- 893b702b6: Collapse the inflight delivery-reliability layer into mode-gated marker-select channels for simpler event relay between plugin bridge and the host.

## 0.2.2

### Patch Changes

- 4955dad6e: chore: refresh dependency range (triggered by @xyz-agent/extension-protocol@0.8.2 → @xyz-agent/extension-protocol@0.9.0, @zhushanwen/pi-ext-guards@0.2.1 → @zhushanwen/pi-ext-guards@0.3.0, @zhushanwen/pi-extension-logger@0.5.0 → @zhushanwen/pi-extension-logger@0.6.0)

## 0.2.1

### Patch Changes

- bbd8e5e8a: chore: refresh dependency range (triggered by @xyz-agent/extension-protocol@0.8.1 → @xyz-agent/extension-protocol@0.8.2)

## 0.2.0

### Minor Changes

- 730fa1779: First release of `@zhushanwen/pi-plugin-bridge`: the Plugin system bridge extension — registers plugin tools into pi and relays events/intercepts to the xyz-agent runtime via the select+marker channel.
