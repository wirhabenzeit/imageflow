#import <AppKit/AppKit.h>
#include <node_api.h>
#include <cstring>

static NSWindow *windowFromHandle(napi_env env, napi_value arg) {
  size_t length = 0;
  void *bytes = nullptr, *pointer = nullptr;
  if (napi_get_buffer_info(env, arg, &bytes, &length) != napi_ok || length != sizeof(void *)) {
    napi_throw_type_error(env, nullptr, "Expected a native window handle.");
    return nil;
  }
  std::memcpy(&pointer, bytes, sizeof(pointer));
  return ((__bridge NSView *)pointer).window;
}

// Test-only measurement of AppKit's real document proxy; renderer screenshots omit the native title bar.
static napi_value inspect(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value arg;
  napi_get_cb_info(env, info, &argc, &arg, nullptr, nullptr);
  if (argc != 1) return nullptr;
  NSWindow *window = windowFromHandle(env, arg);
  if (!window) return nullptr;
  [window.contentView.superview layoutSubtreeIfNeeded];
  NSButton *icon = [window standardWindowButton:NSWindowDocumentIconButton];
  NSRect frame = [icon convertRect:icon.bounds toView:nil];
  napi_value result;
  napi_create_object(env, &result);
  auto number = [&](const char *key, double value) {
    napi_value item;
    napi_create_double(env, value, &item);
    napi_set_named_property(env, result, key, item);
  };
  number("width", window.frame.size.width);
  number("iconX", frame.origin.x);
  number("iconWidth", frame.size.width);
  number("toolbarStyle", window.toolbarStyle);
  number("hasToolbar", window.toolbar ? 1 : 0);
  number("presentationOptions", NSApp.presentationOptions);
  return result;
}

// Hit-test the toolbar and deliver a double-click with a temporary preference in this process only.
static napi_value doubleClick(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value args[4];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  double x, y;
  char action[32];
  if (argc != 4 || napi_get_value_double(env, args[1], &x) != napi_ok ||
      napi_get_value_double(env, args[2], &y) != napi_ok ||
      napi_get_value_string_utf8(env, args[3], action, sizeof(action), nullptr) != napi_ok) {
    napi_throw_type_error(env, nullptr, "Expected a window handle, coordinates and title bar action.");
    return nullptr;
  }
  NSWindow *window = windowFromHandle(env, args[0]);
  if (!window) return nullptr;
  NSView *content = window.contentView;
  NSPoint local = NSMakePoint(x, content.isFlipped ? y : NSHeight(content.bounds) - y);
  NSView *target = [content hitTest:[content convertPoint:local toView:content.superview]];
  if (![NSStringFromClass(target.class) isEqualToString:@"ImageFlowToolbarDrag"]) {
    napi_throw_error(env, nullptr, "The click did not land on the toolbar drag view.");
    return nullptr;
  }
  NSPoint point = [content convertPoint:local toView:nil];
  NSUserDefaults *defaults = NSUserDefaults.standardUserDefaults;
  NSDictionary *before = [defaults volatileDomainForName:NSArgumentDomain];
  NSMutableDictionary *override = [before mutableCopy];
  override[@"AppleActionOnDoubleClick"] = [NSString stringWithUTF8String:action];
  [defaults setVolatileDomain:override forName:NSArgumentDomain];
  [target mouseDown:[NSEvent mouseEventWithType:NSEventTypeLeftMouseDown location:point modifierFlags:0
    timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber context:nil eventNumber:0 clickCount:2 pressure:1]];
  [defaults setVolatileDomain:before forName:NSArgumentDomain];
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

// Posts a double-click in the title row above the content, `fromTop` points below the window's top edge, through the
// event queue as a real click arrives. The temporary preference lasts until the click has been handled.
static napi_value titleRowDoubleClick(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value args[4];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  double x, fromTop;
  char action[32];
  if (argc != 4 || napi_get_value_double(env, args[1], &x) != napi_ok || napi_get_value_double(env, args[2], &fromTop) != napi_ok ||
      napi_get_value_string_utf8(env, args[3], action, sizeof(action), nullptr) != napi_ok) {
    napi_throw_type_error(env, nullptr, "Expected a window handle, coordinates and title bar action.");
    return nullptr;
  }
  NSWindow *window = windowFromHandle(env, args[0]);
  if (!window) return nullptr;
  NSUserDefaults *defaults = NSUserDefaults.standardUserDefaults;
  NSDictionary *before = [defaults volatileDomainForName:NSArgumentDomain];
  NSMutableDictionary *override = [before mutableCopy];
  override[@"AppleActionOnDoubleClick"] = [NSString stringWithUTF8String:action];
  [defaults setVolatileDomain:override forName:NSArgumentDomain];
  NSPoint point = NSMakePoint(x, NSHeight(window.frame) - fromTop);
  for (NSEventType type : (NSEventType[]){ NSEventTypeLeftMouseDown, NSEventTypeLeftMouseUp }) {
    [NSApp postEvent:[NSEvent mouseEventWithType:type location:point modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime
      windowNumber:window.windowNumber context:nil eventNumber:0 clickCount:2 pressure:type == NSEventTypeLeftMouseDown ? 1 : 0] atStart:NO];
  }
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 400 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
    [defaults setVolatileDomain:before forName:NSArgumentDomain];
  });
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static napi_value initialize(napi_env env, napi_value exports) {
  napi_value function;
  napi_create_function(env, "inspect", NAPI_AUTO_LENGTH, inspect, nullptr, &function);
  napi_set_named_property(env, exports, "inspect", function);
  napi_create_function(env, "doubleClick", NAPI_AUTO_LENGTH, doubleClick, nullptr, &function);
  napi_set_named_property(env, exports, "doubleClick", function);
  napi_create_function(env, "titleRowDoubleClick", NAPI_AUTO_LENGTH, titleRowDoubleClick, nullptr, &function);
  napi_set_named_property(env, exports, "titleRowDoubleClick", function);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
