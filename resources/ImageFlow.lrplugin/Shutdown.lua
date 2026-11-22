-- Runs when the plugin is disabled, reloaded or removed: ImageFlow shows its photos as offline at once.
local Bridge = require 'Bridge'
Bridge.stop()
