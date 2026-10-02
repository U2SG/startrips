-- Country defaults supplement the pinned OSRM profile; road tags still win.
local stock = dofile('/opt/foot.lua')
local setup = stock.setup
local process_way = stock.process_way

local function copy(source)
  local target = {}
  for key, value in pairs(source) do target[key] = value end
  return target
end

stock.setup = function()
  local profile = setup()
  local permitted = copy(profile)
  permitted.speeds = copy(profile.speeds)
  permitted.speeds.highway = copy(profile.speeds.highway)
  permitted.speeds.highway.trunk = profile.default_speed
  permitted.speeds.highway.trunk_link = profile.default_speed
  profile.country_trunk_profile = permitted
  return profile
end

stock.process_way = function(profile, way, result, relations)
  local highway = way:get_value_by_key('highway')
  local permitted = (highway == 'trunk' or highway == 'trunk_link')
    and way:get_location_tag('startrips_foot_trunk') == 'yes'
  process_way(permitted and profile.country_trunk_profile or profile, way, result, relations)
end

return stock
