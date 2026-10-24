/**
 * Plugin Provider source (provider-plugin-access U6/D1/D2/D5/D8) i18n: onboarding flow
 * (family picker → install confirmation → authorize mount), entry extension area and
 * entry-level actions.
 *
 * The bulk of the surface is rendered by plugins as GuiComponent trees (plugin copy stays
 * with the plugin, not in host i18n); this domain covers only the host-provided shell and
 * shared fields. Keys are symmetric with zh-CN.
 */
export default {
  // Flow shell
  flow: {
    title: 'Add Plugin Provider',
    subtitle: 'The plugin supplies family metadata, the authorization flow and the model catalog; the host only stores credentials and manages entries',
    authorizeTitle: 'Authorize {name}',
    authorizeSubtitle: 'The authorization flow is rendered by the plugin',
    installTitle: 'Install plugin',
    installSubtitle: 'Review the disclosures below before installing',
    updateTitle: 'Update plugin',
    installedBadge: 'Installed',
    updateBadge: 'Update available',
    installHint: 'Install the plugin first',
    credentialOauth: 'Browser authorization',
    credentialExtract: 'Reads local sign-in state',
    modelCount: '{count} models available',
    emptyCatalog: 'Catalog is empty: no installable provider plugins',
    catalogLoading: 'Loading plugin catalog…',
    // S15 two states (R-2 wire fields): stale = cache-fallback hint; unavailable = no cache and fetch failed (error state)
    staleHint: 'Catalog may be outdated (last fetch was not confirmed fresh)',
    catalogUnavailable: 'Plugin catalog unreachable: no local cache and the fetch failed — check your network and retry',
    retry: 'Retry',
    focusMissing: 'Target plugin is not in the catalog (it may have been removed); reopen this page',
    channelUnavailable: 'Install channel unavailable: update to a version that supports plugin install, then retry',
    confirmFailed: 'Install failed',
    // Install confirmation card (S27 disclosure)
    confirmInstallDesc: 'About to install',
    confirmUpdateDesc: 'About to update',
    capabilitiesLabel: 'Capabilities',
    readPathsLabel: 'Readable paths (readPaths)',
    permissionsLabel: 'Permissions',
    noneDeclared: 'None declared',
    confirmHint: 'Installing grants the capabilities declared above; nothing is written until you confirm.',
    confirmInstall: 'Install',
    confirmUpdate: 'Update',
    cancel: 'Cancel',
    // Direct package install (second S27 path)
    directInstallPlaceholder: "Or enter a plugin package name (e.g. {'@'}scope/plugin-xxx)",
    directInstallBtn: 'Install this package',
  },
  // Entry extension area
  detailExtra: {
    title: 'Plugin content',
  },
  // Entry-level actions
  actions: {
    reauthorize: 'Reauthorize',
    updatePlugin: 'Update plugin',
  },
  // Row marker
  row: {
    pluginBadge: 'Plugin',
  },
  // Credential status (display mapping of plugin reports; nothing reported = no marker, D5/S5)
  status: {
    fallbackValid: 'Credential valid',
    fallbackInvalid: 'Credential may be invalid',
  },
}
