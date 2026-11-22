-- File → Plug-in Extras → Send to ImageFlow: adds the selected photos to the book open in ImageFlow.
local LrApplication = import 'LrApplication'
local LrDialogs = import 'LrDialogs'
local LrFunctionContext = import 'LrFunctionContext'
local LrTasks = import 'LrTasks'

local Bridge = require 'Bridge'
local Catalog = require 'Catalog'

LrFunctionContext.postAsyncTaskWithContext('Send to ImageFlow', function(context)
  LrDialogs.attachErrorDialogToFunctionContext(context)
  local selection = Catalog.selection()
  if #selection.photos == 0 then
    LrDialogs.message('Send to ImageFlow', 'Select the photos to send first. Videos are not sent.', 'info')
    return
  end
  if not Bridge.waitForConnection(5) then
    LrDialogs.message('ImageFlow is not running', 'Open ImageFlow and the book to add the photos to, then choose Send to ImageFlow again.', 'info')
    return
  end
  local ok, sent = LrTasks.pcall(Bridge.send, selection.photos)
  if not (ok and sent) then
    LrDialogs.message('Send to ImageFlow', 'ImageFlow did not accept the photos. Try again once ImageFlow has finished what it is doing.', 'warning')
    return
  end
  local count = #selection.photos
  local message = count == 1 and 'Sent 1 photo to ImageFlow' or ('Sent ' .. count .. ' photos to ImageFlow')
  if LrDialogs.showBezel then LrDialogs.showBezel(message) end
end)
