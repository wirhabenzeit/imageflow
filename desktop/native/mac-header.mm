#import <AppKit/AppKit.h>
#include <node_api.h>
#include <cstring>

// Electron exposes its NSView, but not AppKit's centered document-title layout.
// Keep the real title/proxy button: AppKit continues to own its path menu and dragging.
static napi_value configure(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  void *bytes = nullptr;
  size_t length = 0;
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc != 1 || napi_get_buffer_info(env, args[0], &bytes, &length) != napi_ok || length != sizeof(void *)) {
    napi_throw_type_error(env, nullptr, "Expected Electron's native NSView handle.");
    return nullptr;
  }
  if (![NSThread isMainThread]) {
    napi_throw_error(env, nullptr, "Configure the document header on the main thread.");
    return nullptr;
  }
  void *pointer = nullptr;
  std::memcpy(&pointer, bytes, sizeof(pointer));
  NSWindow *window = ((__bridge NSView *)pointer).window;
  if (!window) {
    napi_throw_error(env, nullptr, "The document view has no window.");
    return nullptr;
  }
  // This public AppKit style keeps the document title centered on macOS 27 as well.
  // No native toolbar row is shown: the existing editor controls sit directly below it.
  NSToolbar *toolbar = [[NSToolbar alloc] initWithIdentifier:@"ImageFlowDocumentHeader"];
  window.toolbar = toolbar;
  toolbar.visible = NO;
  window.toolbarStyle = NSWindowToolbarStylePreference;
  window.titleVisibility = NSWindowTitleVisible;
  window.titlebarSeparatorStyle = NSTitlebarSeparatorStyleNone;
  window.titlebarAppearsTransparent = YES;
  // Match --panel-surface in theme.css, including changes to the app's appearance.
  window.backgroundColor = [NSColor colorWithName:@"ImageFlowHeader" dynamicProvider:^NSColor *(NSAppearance *appearance) {
    BOOL dark = [[appearance bestMatchFromAppearancesWithNames:@[NSAppearanceNameAqua, NSAppearanceNameDarkAqua]] isEqualToString:NSAppearanceNameDarkAqua];
    CGFloat channel = (dark ? 37.0 : 245.0) / 255.0;
    return [NSColor colorWithSRGBRed:channel green:channel blue:channel alpha:1.0];
  }];
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static napi_value initialize(napi_env env, napi_value exports) {
  napi_value function;
  napi_create_function(env, "configure", NAPI_AUTO_LENGTH, configure, nullptr, &function);
  napi_set_named_property(env, exports, "configure", function);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
