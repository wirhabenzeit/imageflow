-- All experiments of the ImageFlow Lightroom Classic spike. Every experiment appends JSON lines to
-- ~/Documents/ImageFlowSpike/log.jsonl; `analyze.mjs` summarizes them. See ../README.md.
local LrApplication = import 'LrApplication'
local LrBinding = import 'LrBinding'
local LrDate = import 'LrDate'
local LrDialogs = import 'LrDialogs'
local LrExportSession = import 'LrExportSession'
local LrFileUtils = import 'LrFileUtils'
local LrFunctionContext = import 'LrFunctionContext'
local LrHttp = import 'LrHttp'
local LrMD5 = import 'LrMD5'
local LrPathUtils = import 'LrPathUtils'
local LrShell = import 'LrShell'
local LrTasks = import 'LrTasks'
local LrView = import 'LrView'

local Spike = { state = { generation = 0, watching = false } }

---------------------------------------------------------------------------------------------------
-- Logging and a minimal JSON encoder (the SDK has none).
---------------------------------------------------------------------------------------------------

function Spike.dir()
  local dir = LrPathUtils.child(LrPathUtils.getStandardFilePath('documents'), 'ImageFlowSpike')
  LrFileUtils.createAllDirectories(dir)
  return dir
end

local escapes = { ['"'] = '\\"', ['\\'] = '\\\\', ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t' }
local function quote(text)
  local escaped = text:gsub('[%c"\\]', function(c) return escapes[c] or string.format('\\u%04x', c:byte()) end)
  return '"' .. escaped .. '"'
end

local function isArray(table_)
  local count = 0
  for key in pairs(table_) do
    if type(key) ~= 'number' then return false end
    count = count + 1
  end
  return count == #table_
end

-- Objects are written with sorted keys, so equal tables give equal text (used for fingerprints).
local function encode(value, depth)
  depth = depth or 0
  local kind = type(value)
  if kind == 'string' then return quote(value) end
  if kind == 'number' then
    if value ~= value or value == math.huge or value == -math.huge then return 'null' end
    return tostring(value)
  end
  if kind == 'boolean' then return tostring(value) end
  if kind == 'table' then
    if depth > 8 then return '"<deep>"' end
    if isArray(value) then
      local parts = {}
      for i = 1, #value do parts[i] = encode(value[i], depth + 1) end
      return '[' .. table.concat(parts, ',') .. ']'
    end
    local keys = {}
    for key in pairs(value) do keys[#keys + 1] = tostring(key) end
    table.sort(keys)
    local parts = {}
    for _, key in ipairs(keys) do
      local item = value[key]
      if item == nil then item = value[tonumber(key)] end
      parts[#parts + 1] = quote(key) .. ':' .. encode(item, depth + 1)
    end
    return '{' .. table.concat(parts, ',') .. '}'
  end
  if kind == 'nil' then return 'null' end
  return quote(tostring(value))
end
Spike.encode = encode

local function hex(digest)
  if #digest ~= 16 then return digest end
  return (digest:gsub('.', function(c) return string.format('%02x', c:byte()) end))
end
local function fingerprint(value) return hex(LrMD5.digest(encode(value))) end

function Spike.log(entry)
  entry.t = LrDate.currentTime() -- seconds since 2001-01-01 GMT, the epoch of lastEditTime
  entry.at = LrDate.timeToUserFormat(entry.t, '%Y-%m-%d %H:%M:%S')
  local file = io.open(LrPathUtils.child(Spike.dir(), 'log.jsonl'), 'a')
  if file then
    file:write(encode(entry), '\n')
    file:close()
  end
end

local function now() return LrDate.currentTime() end

--- Runs an experiment in an async task and logs any error instead of losing it.
function Spike.runTask(name)
  LrTasks.startAsyncTask(function()
    local ok, err = pcall(Spike[name])
    if not ok then
      Spike.log({ kind = 'error', experiment = name, message = tostring(err) })
      LrDialogs.message('ImageFlow Spike: ' .. name .. ' failed', tostring(err), 'critical')
    end
  end)
end

---------------------------------------------------------------------------------------------------
-- Shared helpers
---------------------------------------------------------------------------------------------------

local candidateKeys = {
  'uuid', 'editCount', 'lastEditTime', 'croppedDimensions', 'dimensions', 'isCropped', 'orientation', 'Orientation',
  'rating', 'pickStatus', 'fileSize', 'fileFormat', 'isVirtualCopy', 'copyName', 'countVirtualCopies', 'aspectRatioCache',
  'width', 'height',
}

--- The keys of `candidates` that batchGetRawMetadata accepts, each tried alone because one bad key fails a whole call.
local function workingKeys(catalog, photos, candidates)
  local working, rejected = {}, {}
  for _, key in ipairs(candidates) do
    local ok, result = pcall(catalog.batchGetRawMetadata, catalog, photos, { key })
    if ok and type(result) == 'table' then working[#working + 1] = key else rejected[#rejected + 1] = key .. ': ' .. tostring(result) end
  end
  return working, rejected
end

local function parseSize(value)
  if type(value) == 'table' then return value.width, value.height end
  if type(value) == 'string' then
    local w, h = value:match('(%d+)%s*[xX×]%s*(%d+)')
    return tonumber(w), tonumber(h)
  end
end

local function name(photo)
  local ok, result = pcall(photo.getFormattedMetadata, photo, 'fileName')
  return ok and result or '?'
end

local function targets()
  local catalog = LrApplication.activeCatalog()
  local photos = catalog:getTargetPhotos()
  if #photos == 0 then error('Select at least one photo.') end
  return catalog, photos
end

---------------------------------------------------------------------------------------------------
-- 1 and 2. Watch: which actions change editCount, lastEditTime and croppedDimensions? (Experiment 1 and 2)
---------------------------------------------------------------------------------------------------

local developMarkers = { 'MaskGroupBasedCorrections', 'RetouchAreas', 'GradientBasedCorrections', 'PaintBasedCorrections', 'CircularGradientBasedCorrections' }

local function developInfo(photo)
  local ok, settings = pcall(photo.getDevelopSettings, photo)
  if not ok or type(settings) ~= 'table' then return { error = tostring(settings) } end
  local count = 0
  local present = {}
  for key in pairs(settings) do count = count + 1 end
  for _, marker in ipairs(developMarkers) do
    local value = settings[marker]
    if value ~= nil then present[marker] = type(value) == 'table' and #value or tostring(value) end
  end
  return { hash = fingerprint(settings), keys = count, present = present }
end

function Spike.watchStart()
  local catalog, photos = targets()
  local keys = workingKeys(catalog, photos, { 'uuid', 'editCount', 'lastEditTime', 'croppedDimensions', 'isCropped', 'rating', 'pickStatus' })
  Spike.state.generation = Spike.state.generation + 1
  Spike.state.watching = true
  local generation = Spike.state.generation
  local interval = 1
  Spike.log({ kind = 'watch-start', photos = #photos, keys = keys, interval = interval })

  local previous, develop = {}, {}
  local ticks, spent, slowest = 0, 0, 0
  while Spike.state.watching and Spike.state.generation == generation do
    local started = now()
    local ok, data = pcall(catalog.batchGetRawMetadata, catalog, photos, keys)
    local took = now() - started
    ticks, spent = ticks + 1, spent + took
    if took > slowest then slowest = took end
    if not ok then
      Spike.log({ kind = 'error', experiment = 'watch', message = tostring(data) })
    else
      for _, photo in ipairs(photos) do
        local row = data[photo]
        if row then
          local uuid = row.uuid or tostring(photo)
          local before = previous[uuid]
          if not before then
            develop[uuid] = developInfo(photo)
            Spike.log({ kind = 'initial', uuid = uuid, file = name(photo), values = row, develop = develop[uuid] })
          else
            local changed = {}
            local any = false
            for _, key in ipairs(keys) do
              if row[key] ~= before[key] then
                changed[key] = { before[key], row[key] }
                any = true
              end
            end
            if any then
              local visual = changed.editCount or changed.lastEditTime or changed.croppedDimensions
              local info
              if visual then
                info = developInfo(photo)
                info.changed = develop[uuid] ~= nil and info.hash ~= develop[uuid].hash
                develop[uuid] = info
              end
              local lag
              if row.lastEditTime then lag = now() - row.lastEditTime end
              Spike.log({ kind = 'change', uuid = uuid, file = name(photo), changed = changed, lag = lag, develop = info })
            end
          end
          previous[uuid] = row
        end
      end
    end
    if ticks % 60 == 0 then
      Spike.log({ kind = 'watch-tick', ticks = ticks, averageSeconds = spent / ticks, slowestSeconds = slowest })
    end
    LrTasks.sleep(interval)
  end
  Spike.log({ kind = 'watch-stop', ticks = ticks, averageSeconds = ticks > 0 and spent / ticks or 0, slowestSeconds = slowest })
end

function Spike.watchStop()
  Spike.state.watching = false
  Spike.log({ kind = 'watch-stop-requested' })
end

function Spike.marker()
  LrFunctionContext.callWithContext('marker', function(context)
    local factory = LrView.osFactory()
    local properties = LrBinding.makePropertyTable(context)
    properties.label = ''
    local result = LrDialogs.presentModalDialog({
      title = 'ImageFlow Spike: marker',
      contents = factory:column({
        bind_to_object = properties,
        spacing = factory:control_spacing(),
        factory:static_text({ title = 'Describe the action you are about to do (for example: exposure slider +1):' }),
        factory:edit_field({ value = LrView.bind('label'), width_in_chars = 50 }),
      }),
      actionVerb = 'Add marker',
    })
    if result == 'ok' then Spike.log({ kind = 'marker', label = properties.label }) end
  end)
end

---------------------------------------------------------------------------------------------------
-- 4. Probe keys and identity (Experiment 6, and the orientation key spelling)
---------------------------------------------------------------------------------------------------

function Spike.probe()
  local catalog, photos = targets()
  local working, rejected = workingKeys(catalog, photos, candidateKeys)
  local version = LrApplication.versionTable()
  Spike.log({ kind = 'probe-keys', lightroom = version, catalogPath = catalog:getPath(), working = working, rejected = rejected })
  local data = catalog:batchGetRawMetadata(photos, working)
  for _, photo in ipairs(photos) do
    local row = data[photo] or {}
    local found = row.uuid and catalog:findPhotoByUuid(row.uuid)
    Spike.log({
      kind = 'identity', file = name(photo), path = photo:getRawMetadata('path'), values = row,
      croppedDimensionsType = type(row.croppedDimensions), resolvesByUuid = found ~= nil and found == photo,
    })
  end
end

---------------------------------------------------------------------------------------------------
-- 5. Benchmark batchGetRawMetadata (Experiment 3)
---------------------------------------------------------------------------------------------------

function Spike.benchBatch()
  local catalog = LrApplication.activeCatalog()
  local all = catalog:getAllPhotos()
  Spike.log({ kind = 'bench-batch-start', catalogPhotos = #all })
  local keys = workingKeys(catalog, { all[1] }, { 'uuid', 'editCount', 'lastEditTime', 'croppedDimensions', 'isCropped' })
  for _, size in ipairs({ 50, 500, 2000, 10000 }) do
    if #all >= size then
      local subset = {}
      for i = 1, size do subset[i] = all[i] end
      local times = {}
      for run = 1, 5 do
        local started = now()
        catalog:batchGetRawMetadata(subset, keys)
        times[run] = now() - started
        LrTasks.yield()
      end
      table.sort(times)
      -- The same photos one by one, to check the claim that the batch call is much faster.
      local started = now()
      for i = 1, math.min(size, 500) do subset[i]:getRawMetadata('editCount') end
      Spike.log({ kind = 'bench-batch', photos = size, minSeconds = times[1], medianSeconds = times[3], maxSeconds = times[5],
        singleCallsSeconds = now() - started, singleCalls = math.min(size, 500) })
    end
  end
  -- Stress for the UI: 200 back-to-back calls over the largest subset. Watch whether Lightroom's UI stutters.
  local size = math.min(#all, 2000)
  local subset = {}
  for i = 1, size do subset[i] = all[i] end
  local started = now()
  for _ = 1, 200 do
    catalog:batchGetRawMetadata(subset, keys)
    LrTasks.yield()
  end
  Spike.log({ kind = 'bench-batch-stress', photos = size, calls = 200, totalSeconds = now() - started })
  LrDialogs.message('ImageFlow Spike', 'Batch benchmark finished. See the log.', 'info')
end

---------------------------------------------------------------------------------------------------
-- 6. Benchmark renders (Experiment 4 and 7)
---------------------------------------------------------------------------------------------------

local function exportSettings(folder, base, mode)
  local settings = {
    LR_export_destinationType = 'specificFolder',
    LR_export_destinationPathPrefix = folder,
    LR_export_useSubfolder = false,
    LR_collisionHandling = 'overwrite',
    LR_renamingTokensOn = true,
    LR_tokens = '{{custom_token}}',
    LR_tokenCustomString = base,
    LR_extensionCase = 'lowercase',
    LR_format = 'JPEG',
    LR_export_colorSpace = 'sRGB',
    LR_export_bitDepth = 8,
    LR_minimizeEmbeddedMetadata = true,
    LR_outputSharpeningOn = false,
    LR_useWatermark = false,
    LR_reimportExportedPhoto = false,
    LR_includeVideoFiles = false,
    LR_size_units = 'pixels',
  }
  if mode == 'preview' then
    settings.LR_jpeg_quality = 0.86
    settings.LR_size_doConstrain = true
    settings.LR_size_resizeType = 'wh'
    settings.LR_size_maxWidth = 1400
    settings.LR_size_maxHeight = 1400
    settings.LR_size_doNotEnlarge = true
  else
    settings.LR_jpeg_quality = 0.95
    settings.LR_size_doConstrain = false
  end
  return settings
end

local function readAll(path)
  local content = LrFileUtils.readFile(path)
  return content
end

--- Pixel size of a rendered file, through macOS `sips`.
local function pixelSize(path)
  local output = LrPathUtils.child(Spike.dir(), 'sips.txt')
  LrFileUtils.delete(output)
  LrTasks.execute(string.format('/usr/bin/sips -g pixelWidth -g pixelHeight "%s" > "%s" 2>&1', path, output))
  local text = readAll(output) or ''
  return tonumber(text:match('pixelWidth: (%d+)')), tonumber(text:match('pixelHeight: (%d+)'))
end

--- One render of one photo; returns the result table that is logged.
local function render(catalog, photo, mode, label)
  local folder = LrPathUtils.child(LrPathUtils.child(Spike.dir(), 'renders'), mode)
  LrFileUtils.createAllDirectories(folder)
  local path = LrPathUtils.child(folder, label .. '.jpg')
  LrFileUtils.delete(path)
  local started = now()
  local session = LrExportSession({ photosToExport = { photo }, exportSettings = exportSettings(folder, label, mode) })
  session:doExportOnCurrentTask()
  local seconds = now() - started
  if not LrFileUtils.exists(path) then return { mode = mode, label = label, seconds = seconds, error = 'no file at ' .. path } end
  local content = readAll(path)
  local width, height = pixelSize(path)
  return { mode = mode, label = label, seconds = seconds, bytes = content and #content or 0, md5 = content and hex(LrMD5.digest(content)), width = width, height = height, path = path }
end

function Spike.benchRender()
  local catalog, photos = targets()
  for index = 1, math.min(3, #photos) do
    local photo = photos[index]
    local row = catalog:batchGetRawMetadata({ photo }, { 'uuid', 'croppedDimensions', 'editCount' })[photo] or {}
    local uuid = row.uuid or ('photo' .. index)
    local cw, ch = parseSize(row.croppedDimensions)
    local first = render(catalog, photo, 'preview', uuid .. '-a')
    local second = render(catalog, photo, 'preview', uuid .. '-b')
    local full = render(catalog, photo, 'full', uuid)
    local editCountAfter = catalog:batchGetRawMetadata({ photo }, { 'editCount' })[photo]
    Spike.log({
      kind = 'bench-render', file = name(photo), uuid = uuid, croppedDimensions = row.croppedDimensions, croppedWidth = cw, croppedHeight = ch,
      editCountBefore = row.editCount, editCountAfter = editCountAfter and editCountAfter.editCount,
      preview = first, previewAgain = second, identicalPreviewBytes = first.md5 ~= nil and first.md5 == second.md5, full = full,
      fullMatchesCropped = full.width ~= nil and cw ~= nil and full.width == cw and full.height == ch,
    })
  end
  LrDialogs.message('ImageFlow Spike', 'Render benchmark finished. See the log.', 'info')
end

---------------------------------------------------------------------------------------------------
-- 7. Loopback HTTP (Experiment 5). Start `node server.mjs` first.
---------------------------------------------------------------------------------------------------

function Spike.loopback()
  local base = 'http://127.0.0.1:7421'
  local headers = { { field = 'Authorization', value = 'Bearer spike-token' }, { field = 'Content-Type', value = 'application/json' } }
  local times, statuses = {}, {}
  for i = 1, 20 do
    local started = now()
    local body, response = LrHttp.post(base .. '/ping', encode({ i = i }), headers, 'POST', 5)
    times[i] = now() - started
    statuses[i] = response and response.status or 'none'
    if i == 1 then Spike.log({ kind = 'loopback-first', body = body, status = response and response.status }) end
  end
  table.sort(times)
  Spike.log({ kind = 'loopback-ping', calls = 20, minSeconds = times[1], medianSeconds = times[10], maxSeconds = times[20], firstStatus = statuses[1] })

  -- A long poll must not stop other plugin tasks: count ticks of a second task while a 10 s request is pending.
  local ticks, finished = 0, false
  LrTasks.startAsyncTask(function()
    while not finished do
      LrTasks.sleep(0.5)
      ticks = ticks + 1
    end
  end)
  local started = now()
  local body, response = LrHttp.get(base .. '/poll?hold=10', headers, 30)
  local seconds = now() - started
  finished = true
  Spike.log({ kind = 'loopback-longpoll', seconds = seconds, ticksDuring = ticks, expectedTicks = math.floor(seconds / 0.5), status = response and response.status, body = body })

  -- Wrong token must be refused (checks that the header reaches the server at all).
  local _, denied = LrHttp.get(base .. '/secret', { { field = 'Authorization', value = 'Bearer wrong' } }, 5)
  Spike.log({ kind = 'loopback-auth', status = denied and denied.status })
  LrDialogs.message('ImageFlow Spike', 'Loopback tests finished. See the log.', 'info')
end

function Spike.reveal()
  LrShell.revealInShell(Spike.dir())
end

return Spike
