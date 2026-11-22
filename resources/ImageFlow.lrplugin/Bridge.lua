-- The plugin's side of the loopback bridge to ImageFlow (ADR 0011, section 5). LrHttp can only make requests, so the
-- plugin is the client: it reads ImageFlow's port and token from a file only this user can read, says hello with the
-- open catalog, long-polls for jobs and posts their results. When ImageFlow is not running it tries again, waiting
-- longer each time up to 30 s. It also polls the photos ImageFlow watches and posts the ones whose revision moved.
local LrApplication = import 'LrApplication'
local LrFileUtils = import 'LrFileUtils'
local LrHttp = import 'LrHttp'
local LrPathUtils = import 'LrPathUtils'
local LrTasks = import 'LrTasks'

local Json = require 'Json'
local Catalog = require 'Catalog'

local Bridge = {}

local state = {
  generation = 0,
  session = nil, port = nil, token = nil, catalog = nil,
  -- Set to cut a wait short: Send to ImageFlow wants a connection now.
  wake = false,
  rendering = false,
  watch = {}, watchVersion = 0,
}

-- The version ImageFlow shows and compares; read from Info.lua so there is one place to change it.
local version = (function()
  local ok, info = pcall(require, 'Info')
  return ok and type(info) == 'table' and info.VERSION and info.VERSION.display or '0'
end)()

--- Where ImageFlow writes its port and token: ~/Library/Application Support/ImageFlow/lightroom-bridge.json.
local function bridgeFile()
  local home = LrPathUtils.getStandardFilePath('home')
  return LrPathUtils.child(LrPathUtils.child(LrPathUtils.child(LrPathUtils.child(home, 'Library'), 'Application Support'), 'ImageFlow'), 'lightroom-bridge.json')
end

local function readBridgeFile()
  local path = bridgeFile()
  if LrFileUtils.exists(path) ~= 'file' then return nil end
  local text = LrFileUtils.readFile(path)
  local ok, value = pcall(Json.decode, text)
  if ok and type(value) == 'table' and type(value.port) == 'number' and value.port > 0 and value.port < 65536 and type(value.token) == 'string' then return value end
end

--- One request to ImageFlow; returns the HTTP status (nil when nothing answered) and the decoded body.
local function request(method, path, body, timeout)
  if not state.port or not state.token then return nil end
  -- The token goes only into this header; it is never logged or shown.
  local headers = { { field = 'Authorization', value = 'Bearer ' .. state.token }, { field = 'Content-Type', value = 'application/json' } }
  local url = 'http://127.0.0.1:' .. tostring(state.port) .. path
  local text, info
  if method == 'GET' then text, info = LrHttp.get(url, headers, timeout)
  else text, info = LrHttp.post(url, Json.encode(body or {}), headers, 'POST', timeout) end
  local status = type(info) == 'table' and tonumber(info.status) or nil
  local decoded
  if type(text) == 'string' and text ~= '' then
    local ok, value = pcall(Json.decode, text)
    if ok then decoded = value end
  end
  return status, decoded
end

local function post(path, body, timeout)
  body.session = state.session
  return request('POST', path, body, timeout or 20)
end

function Bridge.connected() return state.session ~= nil end
function Bridge.catalog() return state.catalog end

function Bridge.setWatch(uuids)
  local list = {}
  for _, uuid in ipairs(type(uuids) == 'table' and uuids or {}) do
    if type(uuid) == 'string' then list[#list + 1] = uuid end
  end
  state.watch = list
  state.watchVersion = state.watchVersion + 1
end

local jobs = {}
function jobs.metadata(job) return Catalog.metadata(job.photos) end
function jobs.selection() return Catalog.selection() end
function jobs.watch(job) Bridge.setWatch(job.uuids); return {} end
function jobs.render(job)
  -- One export session at a time: Lightroom shares its export queue with the user's own exports.
  while state.rendering do LrTasks.sleep(0.2) end
  state.rendering = true
  local ok, result = LrTasks.pcall(Catalog.render, job.uuids, job.size, job.folder)
  state.rendering = false
  if not ok then error(result, 0) end
  return result
end

local function run(job, session)
  local handler = type(job) == 'table' and type(job.id) == 'string' and jobs[job.type]
  if not handler then return end
  local ok, result = LrTasks.pcall(handler, job)
  -- A result for a session that ended is of no use to anyone.
  if state.session ~= session then return end
  if ok then post('/lightroom/results', { job = job.id, ok = true, result = result }, 60)
  else post('/lightroom/results', { job = job.id, ok = false, error = tostring(result) }, 60) end
end

--- One connection: hello, then long polls until ImageFlow stops answering. Returns true if a hello succeeded.
local function connectOnce(generation)
  local file = readBridgeFile()
  if not file then return false end
  state.port, state.token = file.port, file.token
  local identity = Catalog.identity()
  local status, hello = request('POST', '/lightroom/hello', {
    catalog = identity, plugin = { version = version }, lightroom = LrApplication.versionString(),
  }, 10)
  if status ~= 200 or type(hello) ~= 'table' or type(hello.session) ~= 'string' then return false end
  local session = hello.session
  state.session, state.catalog = session, identity
  Bridge.setWatch(hello.watch)
  local hold = tonumber(hello.hold) or 25
  while state.generation == generation and state.session == session do
    local pollStatus, answer = request('GET', '/lightroom/jobs?session=' .. session, nil, hold + 15)
    if pollStatus ~= 200 or type(answer) ~= 'table' then break end
    for _, job in ipairs(type(answer.jobs) == 'table' and answer.jobs or {}) do
      LrTasks.startAsyncTask(function() run(job, session) end, 'ImageFlow job')
    end
  end
  if state.session == session then state.session = nil end
  return true
end

local function sleepUnlessWoken(seconds, generation)
  local waited = 0
  while waited < seconds and not state.wake and state.generation == generation do
    LrTasks.sleep(0.5)
    waited = waited + 0.5
  end
  state.wake = false
end

-- The change poll: every 1.5 s while ImageFlow watches photos, nothing otherwise. A photo is reported only once its
-- revision has been the same for one poll, so a dragged slider is one change, not many (ADR 0011, §3.5).
local function watchLoop(generation)
  local cache, cacheVersion = {}, -1
  local last, pending = {}, {}
  while state.generation == generation do
    if state.session and #state.watch > 0 then
      local catalog = LrApplication.activeCatalog()
      if cacheVersion ~= state.watchVersion then
        cache, cacheVersion = {}, state.watchVersion
        -- A change still waiting out its one poll stays pending: `last` already holds its new revision, so
        -- dropping it here would lose the change for good.
        local still, waiting = {}, {}
        for _, uuid in ipairs(state.watch) do still[uuid] = last[uuid]; waiting[uuid] = pending[uuid] end
        last, pending = still, waiting
      end
      local photos, uuidOf = {}, {}
      for _, uuid in ipairs(state.watch) do
        local photo = cache[uuid]
        if photo == nil then photo = catalog:findPhotoByUuid(uuid) or false; cache[uuid] = photo end
        if photo then photos[#photos + 1] = photo; uuidOf[photo] = uuid end
      end
      local ok, revisions = LrTasks.pcall(Catalog.revisions, photos)
      if ok then
        local changed = {}
        local seen = {}
        for photo, revision in pairs(revisions) do
          local uuid = uuidOf[photo]
          seen[uuid] = true
          if last[uuid] == nil then last[uuid] = revision
          elseif last[uuid] ~= revision then last[uuid] = revision; pending[uuid] = true
          elseif pending[uuid] then pending[uuid] = nil; changed[#changed + 1] = uuid end
        end
        -- A photo that was there and is no longer: removed from the catalog.
        for uuid, revision in pairs(last) do
          if not seen[uuid] and revision ~= false then last[uuid] = false; cache[uuid] = nil; changed[#changed + 1] = uuid end
        end
        if #changed > 0 then post('/lightroom/changes', { uuids = changed }, 10) end
      else
        -- A cached LrPhoto of a photo that left the catalog can make the batch call throw; look every photo up again
        -- on the next poll instead of failing on the stale one forever.
        cache = {}
      end
    end
    -- While a render runs, other tasks wait their turn anyway; poll less often.
    LrTasks.sleep(state.rendering and 4 or 1.5)
  end
end

--- Starts the bridge: the connection loop and the change poll, each in its own task.
function Bridge.start()
  state.generation = state.generation + 1
  local generation = state.generation
  LrTasks.startAsyncTask(function()
    local wait = 1
    while state.generation == generation do
      local ok, connected = LrTasks.pcall(connectOnce, generation)
      if ok and connected then wait = 1 end
      if state.generation ~= generation then break end
      sleepUnlessWoken(wait, generation)
      wait = math.min(wait * 2, 30)
    end
  end, 'ImageFlow bridge')
  LrTasks.startAsyncTask(function()
    while state.generation == generation do
      LrTasks.pcall(watchLoop, generation)
      if state.generation == generation then LrTasks.sleep(5) end
    end
  end, 'ImageFlow watch')
end

--- Stops both loops and tells ImageFlow, so it shows the photos as offline at once.
function Bridge.stop()
  state.generation = state.generation + 1
  if state.session then
    LrTasks.startAsyncTask(function() LrTasks.pcall(post, '/lightroom/bye', {}, 2); state.session = nil end, 'ImageFlow bye')
  end
end

--- Waits up to `seconds` for a connection, asking the loop to try at once. True when connected.
function Bridge.waitForConnection(seconds)
  state.wake = true
  local waited = 0
  while not state.session and waited < seconds do
    LrTasks.sleep(0.25)
    waited = waited + 0.25
  end
  return state.session ~= nil
end

--- Send to ImageFlow: the photos selected in Lightroom, into the book open in ImageFlow.
function Bridge.send(photos)
  local status, answer = post('/lightroom/send', { catalog = state.catalog and state.catalog.id, photos = photos }, 20)
  return status == 202, answer
end

return Bridge
