-- ImageFlow companion plugin for Lightroom Classic (ADR 0011). ImageFlow bundles it and installs it into
-- ~/Library/Application Support/Adobe/Lightroom/Modules from Settings; ImageFlow compares VERSION with its own copy.
return {
  LrSdkVersion = 13.0,
  LrSdkMinimumVersion = 13.0,
  LrToolkitIdentifier = 'ch.wirhabenzeit.imageflow.lightroom',
  LrPluginName = 'ImageFlow',
  LrPluginInfoUrl = 'https://github.com/wirhabenzeit/imageflow',
  -- Started with Lightroom, not on first use: it connects to ImageFlow without a URL handler (ADR 0011, section 5).
  LrForceInitPlugin = true,
  LrInitPlugin = 'Init.lua',
  LrShutdownPlugin = 'Shutdown.lua',
  LrPluginInfoProvider = 'PluginInfo.lua',
  -- File → Plug-in Extras works in every module; Library → Plug-in Extras too.
  LrExportMenuItems = { { title = 'Send to ImageFlow', file = 'SendToImageFlow.lua', enabledWhen = 'photosSelected' } },
  LrLibraryMenuItems = { { title = 'Send to ImageFlow', file = 'SendToImageFlow.lua', enabledWhen = 'photosSelected' } },
  VERSION = { major = 1, minor = 1, revision = 0, display = '1.1.0' },
}
