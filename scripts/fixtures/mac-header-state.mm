#import <AppKit/AppKit.h>
#include <node_api.h>
#include <cstring>

// Test-only measurement of AppKit's real document proxy; renderer screenshots omit the native title bar.
static napi_value inspect(napi_env env, napi_callback_info info) {
  size_t argc = 1, length = 0;
  napi_value arg;
  void *bytes = nullptr, *pointer = nullptr;
  napi_get_cb_info(env, info, &argc, &arg, nullptr, nullptr);
  if (argc != 1 || napi_get_buffer_info(env, arg, &bytes, &length) != napi_ok || length != sizeof(void *)) {
    napi_throw_type_error(env, nullptr, "Expected a native window handle.");
    return nullptr;
  }
  std::memcpy(&pointer, bytes, sizeof(pointer));
  NSWindow *window = ((__bridge NSView *)pointer).window;
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
  return result;
}

static napi_value initialize(napi_env env, napi_value exports) {
  napi_value function;
  napi_create_function(env, "inspect", NAPI_AUTO_LENGTH, inspect, nullptr, &function);
  napi_set_named_property(env, exports, "inspect", function);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
