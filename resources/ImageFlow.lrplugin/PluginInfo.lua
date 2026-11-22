-- What the Plug-in Manager shows for the plugin: whether it is connected to ImageFlow.
local Bridge = require 'Bridge'

return {
  sectionsForTopOfDialog = function(factory)
    local connected = Bridge.connected()
    local catalog = Bridge.catalog()
    return { {
      title = 'ImageFlow',
      factory:row({ factory:static_text({
        title = connected and ('Connected to ImageFlow' .. (catalog and catalog.name and (' with ' .. catalog.name) or '') .. '.')
          or 'Not connected. Open ImageFlow; the plugin connects by itself within 30 seconds.',
        fill_horizontal = 1,
      }) }),
      factory:row({ factory:static_text({
        title = 'Add photos with File → Plug-in Extras → Send to ImageFlow, or in ImageFlow with File → Import from Lightroom Classic….',
        fill_horizontal = 1,
      }) }),
    } }
  end,
}
