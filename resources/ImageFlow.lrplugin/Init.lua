-- Runs when Lightroom starts (LrForceInitPlugin) or the plugin is reloaded: connects to ImageFlow when it is running.
local Bridge = require 'Bridge'
Bridge.start()
