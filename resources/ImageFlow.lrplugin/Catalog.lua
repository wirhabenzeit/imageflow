-- What the plugin reads from and renders out of the open catalog (ADR 0011, sections 1 to 4). Everything here
-- yields (catalog calls, exports), so it runs inside a task and is guarded with LrTasks.pcall by its caller.
local LrApplication = import 'LrApplication'
local LrExportSession = import 'LrExportSession'
local LrFileUtils = import 'LrFileUtils'
local LrMD5 = import 'LrMD5'
local LrPathUtils = import 'LrPathUtils'
local LrTasks = import 'LrTasks'
local LrUUID = import 'LrUUID'

local Json = require 'Json'

local Catalog = {}

local function hex(digest)
  if type(digest) ~= 'string' or #digest ~= 16 then return digest end
  return (digest:gsub('.', function(c) return string.format('%02x', c:byte()) end))
end

local function size(value)
  if type(value) == 'table' then return tonumber(value.width), tonumber(value.height) end
  if type(value) == 'string' then
    local w, h = value:match('(%d+)%s*[xX]%s*(%d+)')
    return tonumber(w), tonumber(h)
  end
end

--- The catalog's identity: a UUID the plugin keeps in the catalog's own plug-in properties, so it moves with the
--- catalog and is the same on every Mac, unlike its path. Made once, the first time the plugin runs in a catalog.
function Catalog.identity()
  local catalog = LrApplication.activeCatalog()
  local path = catalog:getPath() or ''
  local name = LrPathUtils.leafName(path)
  local ok, id = LrTasks.pcall(catalog.getPropertyForPlugin, catalog, _PLUGIN, 'catalogId')
  if not (ok and type(id) == 'string' and id:match('^[%w][%w%-]+$') and #id >= 8 and #id <= 64) then
    local made = LrUUID.generateUUID()
    LrTasks.pcall(catalog.withPrivateWriteAccessDo, catalog, function()
      catalog:setPropertyForPlugin(_PLUGIN, 'catalogId', made)
    end, { timeout = 10 })
    local read, stored = LrTasks.pcall(catalog.getPropertyForPlugin, catalog, _PLUGIN, 'catalogId')
    -- Without plug-in properties the path identifies the catalog on this Mac; moving it then loses its photos.
    id = (read and type(stored) == 'string' and stored ~= '') and stored or ('path-' .. hex(LrMD5.digest(path)))
  end
  return { id = id, name = name }
end

-- Raw keys the spike proved in Lightroom Classic 16.0.1, then keys that are probed once, each by itself, because one
-- unknown key fails a whole batch call.
local baseRaw = { 'uuid', 'lastEditTime', 'editCount', 'croppedDimensions', 'orientation', 'fileFormat' }
local optionalRaw = { 'dateTimeOriginalISO8601', 'gps' }
local optionalFormatted = { 'fileName', 'title', 'caption', 'copyright', 'creator', 'cameraMake', 'cameraModel', 'altTextAccessibility' }
local keys

local function probe(catalog, photo)
  local raw, formatted = {}, {}
  for _, key in ipairs(baseRaw) do raw[#raw + 1] = key end
  for _, key in ipairs(optionalRaw) do
    local ok, result = LrTasks.pcall(catalog.batchGetRawMetadata, catalog, { photo }, { key })
    if ok and type(result) == 'table' then raw[#raw + 1] = key end
  end
  for _, key in ipairs(optionalFormatted) do
    local ok, result = LrTasks.pcall(catalog.batchGetFormattedMetadata, catalog, { photo }, { key })
    if ok and type(result) == 'table' then formatted[#formatted + 1] = key end
  end
  keys = { raw = raw, formatted = formatted }
end

--- `lrRevision` (ADR 0011, §3.1): uuid : lastEditTime : editCount : cropped size. Any change Lightroom records moves it.
function Catalog.revision(raw)
  local width, height = size(raw.croppedDimensions)
  local revision = string.format('%s:%.6f:%d:%dx%d', tostring(raw.uuid), tonumber(raw.lastEditTime) or 0,
    math.floor(tonumber(raw.editCount) or 0), math.floor(width or 0), math.floor(height or 0))
  return revision, width, height
end

--- The hash of the develop settings (§3.2): it moves with visual edits, masks included, and not with metadata edits.
function Catalog.developHash(photo)
  local ok, settings = LrTasks.pcall(photo.getDevelopSettings, photo)
  if not ok or type(settings) ~= 'table' then return nil end
  return hex(LrMD5.digest(Json.encode(settings)))
end

local function photosFor(catalog, uuids)
  local found, missing, uuidOf = {}, {}, {}
  for _, uuid in ipairs(uuids) do
    local photo = type(uuid) == 'string' and catalog:findPhotoByUuid(uuid) or nil
    if photo then found[#found + 1] = photo; uuidOf[photo] = uuid else missing[#missing + 1] = uuid end
  end
  return found, missing, uuidOf
end

--- The metadata job: one batch call for revisions and facts, and the develop hash only where the revision moved.
function Catalog.metadata(items)
  local catalog = LrApplication.activeCatalog()
  local uuids, known = {}, {}
  for _, item in ipairs(items or {}) do
    if type(item) == 'table' and type(item.uuid) == 'string' then uuids[#uuids + 1] = item.uuid; known[item.uuid] = item.known end
  end
  local found, missing, uuidOf = photosFor(catalog, uuids)
  local rows = {}
  if #found > 0 then
    if not keys then probe(catalog, found[1]) end
    local raw = catalog:batchGetRawMetadata(found, keys.raw)
    local formatted = #keys.formatted > 0 and catalog:batchGetFormattedMetadata(found, keys.formatted) or {}
    for _, photo in ipairs(found) do
      local r, f, uuid = raw[photo] or {}, formatted[photo] or {}, uuidOf[photo]
      local revision, width, height = Catalog.revision(r)
      if width and height and width > 0 and height > 0 then
        local row = {
          uuid = uuid, revision = revision, width = math.floor(width), height = math.floor(height),
          orientation = type(r.orientation) == 'string' and r.orientation or nil,
          captured = type(r.dateTimeOriginalISO8601) == 'string' and r.dateTimeOriginalISO8601 or nil,
          fileName = f.fileName, title = f.title, caption = f.caption, copyright = f.copyright, creator = f.creator,
          cameraMake = f.cameraMake, cameraModel = f.cameraModel, altText = f.altTextAccessibility,
        }
        if type(r.gps) == 'table' and tonumber(r.gps.latitude) and tonumber(r.gps.longitude) then
          row.gps = { latitude = tonumber(r.gps.latitude), longitude = tonumber(r.gps.longitude) }
        end
        if known[uuid] ~= revision then row.developHash = Catalog.developHash(photo) end
        rows[#rows + 1] = row
      else
        -- A photo without a size (a video, say) cannot be laid out.
        missing[#missing + 1] = uuid
      end
    end
  end
  return { photos = rows, missing = missing }
end

local function state(catalog, photo)
  local raw = catalog:batchGetRawMetadata({ photo }, { 'uuid', 'lastEditTime', 'editCount', 'croppedDimensions' })[photo] or {}
  local revision = Catalog.revision(raw)
  return { revision = revision, developHash = Catalog.developHash(photo) }
end

local function exportSettings(folder, size)
  local settings = {
    LR_export_destinationType = 'specificFolder',
    LR_export_destinationPathPrefix = folder,
    LR_export_useSubfolder = false,
    -- Two photos with the same name (virtual copies) get two files; each rendition reports its own path.
    LR_collisionHandling = 'rename',
    LR_renamingTokensOn = true,
    LR_tokens = '{{image_name}}',
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
  if size == 'preview' then
    -- 1400 px on the long edge, sRGB, quality 86 (ADR 0011, section 2).
    settings.LR_jpeg_quality = 0.86
    settings.LR_size_doConstrain = true
    settings.LR_size_resizeType = 'wh'
    settings.LR_size_maxWidth = 1400
    settings.LR_size_maxHeight = 1400
    settings.LR_size_doNotEnlarge = true
  else
    -- Full size, quality 95: as fast as a print-size render and valid when the photo is resized (section 4.3).
    settings.LR_jpeg_quality = 0.95
    settings.LR_size_doConstrain = false
  end
  return settings
end

--- The render job: one export session of a few photos into the folder ImageFlow named, with each photo's revision
--- read before the session and after its own render, so ImageFlow can discard a render of a photo edited meanwhile.
function Catalog.render(uuids, size, folder)
  if type(folder) ~= 'string' or folder:sub(1, 1) ~= '/' or LrFileUtils.exists(folder) ~= 'directory' then error('ImageFlow named no folder to render into.') end
  if size ~= 'preview' and size ~= 'full' then error('Unknown render size.') end
  local catalog = LrApplication.activeCatalog()
  local found, missing, uuidOf = photosFor(catalog, uuids or {})
  local renders, failed, before = {}, {}, {}
  if #found == 0 then return { renders = renders, missing = missing, failed = failed } end
  for _, photo in ipairs(found) do before[photo] = state(catalog, photo) end
  local session = LrExportSession({ photosToExport = found, exportSettings = exportSettings(folder, size) })
  for _, rendition in session:renditions() do
    local ok, pathOrMessage = rendition:waitForRender()
    local photo = rendition.photo
    local uuid = uuidOf[photo]
    if uuid then
      if ok and type(pathOrMessage) == 'string' and LrFileUtils.exists(pathOrMessage) == 'file' then
        renders[#renders + 1] = { uuid = uuid, file = pathOrMessage, before = before[photo], after = state(catalog, photo) }
      else
        failed[#failed + 1] = { uuid = uuid, error = tostring(pathOrMessage or 'Lightroom rendered nothing.') }
      end
    end
  end
  return { renders = renders, missing = missing, failed = failed }
end

-- The long edge asked for, in pixels: Lightroom answers with the preview level of at least this size it keeps.
local thumbnailEdge = 1400
-- How long Lightroom may take for one job's thumbnails; it builds previews it does not have yet.
local thumbnailTimeout = 60

--- The thumbnails job: the previews Lightroom keeps itself, written into the folder ImageFlow named (ADR 0011, section
--- 2). Lightroom keys them by the develop settings, so it never hands out one from before an edit: while a photo that
--- was just edited has none (in Develop) it refuses, and the photo is listed in `refused`. Like renders, each comes with
--- the photo's revision before it was asked for and after it came.
function Catalog.thumbnails(items, folder)
  if type(folder) ~= 'string' or folder:sub(1, 1) ~= '/' or LrFileUtils.exists(folder) ~= 'directory' then error('ImageFlow named no folder for thumbnails.') end
  local catalog = LrApplication.activeCatalog()
  local uuids, known = {}, {}
  for _, item in ipairs(items or {}) do
    if type(item) == 'table' and type(item.uuid) == 'string' then uuids[#uuids + 1] = item.uuid; known[item.uuid] = item.known end
  end
  local found, missing, uuidOf = photosFor(catalog, uuids)
  local before = Catalog.revisions(found)
  local data, problems, waiting, closed = {}, {}, 0, false
  -- A request Lightroom's own collector takes back is never answered, so each is held until the job ends.
  local requests = {}
  for index, photo in ipairs(found) do
    waiting = waiting + 1
    local answered = false
    local function answer(jpeg, problem)
      -- Lightroom may call more than once; the first answer counts.
      if answered or closed then return end
      answered = true
      waiting = waiting - 1
      if type(jpeg) == 'string' and #jpeg > 0 then data[photo] = jpeg else problems[photo] = tostring(problem or 'Lightroom has no preview.') end
    end
    local ok, request = LrTasks.pcall(function() return photo:requestJpegThumbnail(thumbnailEdge, thumbnailEdge, answer) end)
    if ok then requests[index] = request else answer(nil, request) end
  end
  local waited = 0
  while waiting > 0 and waited < thumbnailTimeout do
    LrTasks.sleep(0.02)
    waited = waited + 0.02
  end
  closed = true
  local after = Catalog.revisions(found)
  local thumbnails, refused = {}, {}
  for index, photo in ipairs(found) do
    local uuid, jpeg = uuidOf[photo], data[photo]
    if jpeg and before[photo] and after[photo] then
      local path = LrPathUtils.child(folder, 'thumbnail-' .. index .. '.jpg')
      local file, problem = io.open(path, 'wb')
      if not file then error('Could not write a thumbnail: ' .. tostring(problem)) end
      file:write(jpeg)
      file:close()
      -- ImageFlow knows the develop settings of the revision it named; they are read only for another one.
      local hash = known[uuid] ~= after[photo] and Catalog.developHash(photo) or nil
      thumbnails[#thumbnails + 1] = { uuid = uuid, file = path, before = { revision = before[photo] }, after = { revision = after[photo], developHash = hash } }
    else
      refused[#refused + 1] = { uuid = uuid, error = problems[photo] or 'Lightroom did not answer in time.' }
    end
  end
  return { thumbnails = thumbnails, missing = missing, refused = refused }
end

--- The photos selected in Lightroom, without videos. With nothing selected, Lightroom's target photos are the whole
--- filmstrip; that is never what Import from Lightroom Classic… means, so no selection is an empty one.
function Catalog.selection()
  local catalog = LrApplication.activeCatalog()
  local identity = Catalog.identity()
  local photos = {}
  if catalog:getTargetPhoto() then
    local targets = catalog:getTargetPhotos()
    local raw = catalog:batchGetRawMetadata(targets, { 'uuid', 'fileFormat' })
    local names = catalog:batchGetFormattedMetadata(targets, { 'fileName' })
    for _, photo in ipairs(targets) do
      local r = raw[photo] or {}
      if type(r.uuid) == 'string' and r.fileFormat ~= 'VIDEO' then
        photos[#photos + 1] = { uuid = r.uuid, name = (names[photo] or {}).fileName }
      end
    end
  end
  return { catalog = identity.id, photos = photos }
end

--- The revisions of the photos ImageFlow watches, for the change poll (§3.6): uuid → revision, or nil when gone.
function Catalog.revisions(photos)
  local catalog = LrApplication.activeCatalog()
  local result = {}
  if #photos == 0 then return result end
  local raw = catalog:batchGetRawMetadata(photos, { 'uuid', 'lastEditTime', 'editCount', 'croppedDimensions' })
  for _, photo in ipairs(photos) do
    local r = raw[photo]
    if r and r.uuid then result[photo] = (Catalog.revision(r)) end
  end
  return result
end

return Catalog
