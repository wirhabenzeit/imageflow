-- ImageFlow Lightroom Classic spike (ADR 0011). Not the product plugin: it only measures and logs.
return {
  LrSdkVersion = 6.0,
  LrSdkMinimumVersion = 6.0,
  LrToolkitIdentifier = 'com.imageflow.spike',
  LrPluginName = 'ImageFlow Spike',
  LrForceInitPlugin = true,
  -- File → Plug-in Extras (LrExportMenuItems) is available in every module, Develop included.
  LrExportMenuItems = {
    { title = '1. Watch selected photos: start', file = 'WatchStart.lua', enabledWhen = 'photosSelected' },
    { title = '2. Watch selected photos: stop', file = 'WatchStop.lua' },
    { title = '3. Add marker to log…', file = 'Marker.lua' },
    { title = '4. Probe keys and identity (selected photos)', file = 'Probe.lua', enabledWhen = 'photosSelected' },
    { title = '5. Benchmark batchGetRawMetadata', file = 'BenchBatch.lua' },
    { title = '6. Benchmark renders (first 3 selected photos)', file = 'BenchRender.lua', enabledWhen = 'photosSelected' },
    { title = '7. Loopback HTTP tests (needs server.mjs)', file = 'Loopback.lua' },
    { title = '8. Reveal log folder', file = 'Reveal.lua' },
    { title = '9. Benchmark batch export (up to 20 selected photos)', file = 'BatchExport.lua', enabledWhen = 'photosSelected' },
  },
  VERSION = { major = 0, minor = 1, revision = 0 },
}
