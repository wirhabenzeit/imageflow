#!/bin/sh
# Starts the MCP bridge of the installed ImageFlow app, as Settings → Agents configures it. The bridge runs inside
# ImageFlow's own executable in Node mode, so it always matches the installed app. Set IMAGEFLOW_APP to use an app
# outside /Applications or ~/Applications.
for app in "$IMAGEFLOW_APP" /Applications/ImageFlow.app "$HOME/Applications/ImageFlow.app"; do
  if [ -n "$app" ] && [ -x "$app/Contents/MacOS/ImageFlow" ]; then
    ELECTRON_RUN_AS_NODE=1 exec "$app/Contents/MacOS/ImageFlow" "$app/Contents/Resources/app.asar.unpacked/mcp-bridge.cjs" \
      --connection "$HOME/Library/Application Support/ImageFlow/mcp-connection.json"
  fi
done
echo "ImageFlow.app was not found in /Applications or ~/Applications. Install ImageFlow, or set IMAGEFLOW_APP to its location." >&2
exit 1
