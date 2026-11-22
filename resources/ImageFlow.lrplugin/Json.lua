-- A small JSON encoder and decoder: the SDK has none. Objects are encoded with sorted keys, so equal tables give equal
-- text, which the develop-settings hash relies on.
local Json = {}

local escapes = { ['"'] = '\\"', ['\\'] = '\\\\', ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t', ['\b'] = '\\b', ['\f'] = '\\f' }
local function quote(text)
  return '"' .. text:gsub('[%c"\\]', function(c) return escapes[c] or string.format('\\u%04x', c:byte()) end) .. '"'
end

local function isArray(value)
  local count = 0
  for key in pairs(value) do
    if type(key) ~= 'number' or key < 1 or key % 1 ~= 0 then return false end
    count = count + 1
  end
  return count == #value
end

local function encode(value, depth)
  local kind = type(value)
  if kind == 'string' then return quote(value) end
  if kind == 'number' then
    if value ~= value or value == math.huge or value == -math.huge then return 'null' end
    if value % 1 == 0 and math.abs(value) < 1e15 then return string.format('%d', value) end
    return string.format('%.17g', value)
  end
  if kind == 'boolean' then return tostring(value) end
  if kind == 'table' then
    -- Develop settings nest masks inside mask groups; far deeper than this is a cycle.
    if depth > 64 then error('JSON: value nested too deeply') end
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
  -- Userdata (an LrPhoto, say) has no JSON form; its text stands in, so a hash still sees that something is there.
  return quote(tostring(value))
end

function Json.encode(value) return encode(value, 0) end

-- Decoding: a recursive descent over the text. `null` becomes nil; ImageFlow never sends null inside an array.
local function utf8(code)
  if code < 0x80 then return string.char(code) end
  if code < 0x800 then return string.char(0xC0 + math.floor(code / 0x40), 0x80 + code % 0x40) end
  if code < 0x10000 then return string.char(0xE0 + math.floor(code / 0x1000), 0x80 + math.floor(code / 0x40) % 0x40, 0x80 + code % 0x40) end
  return string.char(0xF0 + math.floor(code / 0x40000), 0x80 + math.floor(code / 0x1000) % 0x40, 0x80 + math.floor(code / 0x40) % 0x40, 0x80 + code % 0x40)
end

local decodeValue

local function skip(text, at)
  return text:find('[^ \t\r\n]', at) or #text + 1
end

local function decodeString(text, at)
  local parts, i = {}, at + 1
  while true do
    local c = text:sub(i, i)
    if c == '' then error('JSON: unterminated string') end
    if c == '"' then return table.concat(parts), i + 1 end
    if c == '\\' then
      local e = text:sub(i + 1, i + 1)
      local simple = ({ ['"'] = '"', ['\\'] = '\\', ['/'] = '/', b = '\b', f = '\f', n = '\n', r = '\r', t = '\t' })[e]
      if simple then parts[#parts + 1] = simple; i = i + 2
      elseif e == 'u' then
        local code = tonumber(text:sub(i + 2, i + 5), 16)
        if not code then error('JSON: bad escape') end
        i = i + 6
        -- A surrogate pair.
        if code >= 0xD800 and code <= 0xDBFF and text:sub(i, i + 1) == '\\u' then
          local low = tonumber(text:sub(i + 2, i + 5), 16)
          if low and low >= 0xDC00 and low <= 0xDFFF then code = 0x10000 + (code - 0xD800) * 0x400 + (low - 0xDC00); i = i + 6 end
        end
        parts[#parts + 1] = utf8(code)
      else error('JSON: bad escape') end
    else
      local stop = text:find('["\\]', i) or #text + 1
      parts[#parts + 1] = text:sub(i, stop - 1)
      i = stop
    end
  end
end

decodeValue = function(text, at, depth)
  if depth > 64 then error('JSON: nested too deeply') end
  at = skip(text, at)
  local c = text:sub(at, at)
  if c == '{' then
    local object = {}
    at = skip(text, at + 1)
    if text:sub(at, at) == '}' then return object, at + 1 end
    while true do
      at = skip(text, at)
      if text:sub(at, at) ~= '"' then error('JSON: expected a key') end
      local key
      key, at = decodeString(text, at)
      at = skip(text, at)
      if text:sub(at, at) ~= ':' then error('JSON: expected a colon') end
      object[key], at = decodeValue(text, at + 1, depth + 1)
      at = skip(text, at)
      local next = text:sub(at, at)
      if next == '}' then return object, at + 1 end
      if next ~= ',' then error('JSON: expected a comma') end
      at = at + 1
    end
  elseif c == '[' then
    local array = {}
    at = skip(text, at + 1)
    if text:sub(at, at) == ']' then return array, at + 1 end
    while true do
      local item
      item, at = decodeValue(text, at, depth + 1)
      array[#array + 1] = item
      at = skip(text, at)
      local next = text:sub(at, at)
      if next == ']' then return array, at + 1 end
      if next ~= ',' then error('JSON: expected a comma') end
      at = at + 1
    end
  elseif c == '"' then return decodeString(text, at)
  elseif text:sub(at, at + 3) == 'true' then return true, at + 4
  elseif text:sub(at, at + 4) == 'false' then return false, at + 5
  elseif text:sub(at, at + 3) == 'null' then return nil, at + 4
  else
    local number = text:match('^-?%d+%.?%d*[eE]?[-+]?%d*', at)
    if not number or number == '' or not tonumber(number) then error('JSON: unexpected character') end
    return tonumber(number), at + #number
  end
end

function Json.decode(text)
  if type(text) ~= 'string' then error('JSON: expected text') end
  local value, at = decodeValue(text, 1, 0)
  if skip(text, at) <= #text then error('JSON: trailing characters') end
  return value
end

return Json
