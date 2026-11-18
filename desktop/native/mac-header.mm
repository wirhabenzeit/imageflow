#import <AppKit/AppKit.h>
#include <node_api.h>
#include <cstring>

// A transparent native drag target lets AppKit receive mouseDown directly,
// before Chromium handles it. Buttons and the document pass through untouched.
@interface ImageFlowToolbarDrag : NSView
@property(nonatomic, copy) NSArray<NSValue *> *regions;
@property(nonatomic, strong) NSValue *frameBeforeFill;
- (void)performTitleBarAction;
@end
@implementation ImageFlowToolbarDrag
- (BOOL)isFlipped { return YES; }
- (BOOL)acceptsFirstMouse:(NSEvent *)event { return YES; }
- (NSView *)hitTest:(NSPoint)point {
  NSEvent *event = NSApp.currentEvent;
  if ((event.modifierFlags & NSEventModifierFlagControl) || event.type == NSEventTypeRightMouseDown ||
      (self.window.styleMask & NSWindowStyleMaskFullScreen) || !self.regions.count) return nil;
  NSPoint local = [self convertPoint:point fromView:self.superview];
  if (!NSPointInRect(local, self.regions.firstObject.rectValue)) return nil;
  for (NSUInteger index = 1; index < self.regions.count; ++index) {
    if (NSPointInRect(local, self.regions[index].rectValue)) return nil;
  }
  return self;
}
- (void)mouseDown:(NSEvent *)event {
  if (event.clickCount != 2) {
    [self.window performWindowDragWithEvent:event];
    return;
  }
  [self performTitleBarAction];
}
// The user's "Double-click a window's title bar to" setting, for the blank editor toolbar and the title row above it.
- (void)performTitleBarAction {
  NSWindow *window = self.window;
  NSString *action = [NSUserDefaults.standardUserDefaults stringForKey:@"AppleActionOnDoubleClick"];
  if (!action || [action isEqualToString:@"Maximize"] || [action isEqualToString:@"Zoom"]) {
    [window performZoom:nil];
  } else if ([action isEqualToString:@"Minimize"]) {
    [window performMiniaturize:nil];
  } else if ([action isEqualToString:@"Fill"] && (window.styleMask & NSWindowStyleMaskResizable)) {
    NSScreen *screen = window.screen;
    if (!screen) return;
    NSRect visible = screen.visibleFrame;
    if (NSEqualRects(window.frame, visible)) {
      if (self.frameBeforeFill) {
        [window setFrame:[window constrainFrameRect:self.frameBeforeFill.rectValue toScreen:screen] display:YES];
        self.frameBeforeFill = nil;
      }
    } else {
      self.frameBeforeFill = [NSValue valueWithRect:window.frame];
      [window setFrame:visible display:YES];
    }
  }
}
@end

static ImageFlowToolbarDrag *dragView(NSWindow *window) {
  for (NSView *view in window.contentView.subviews) {
    if ([view isKindOfClass:ImageFlowToolbarDrag.class]) return (ImageFlowToolbarDrag *)view;
  }
  return nil;
}

// Whether a double-click at `point` (window coordinates) is on the blank title row above the content: not on a window
// button or the document icon, which keep their own clicks.
static BOOL inBlankTitleRow(NSWindow *window, NSPoint point) {
  if (window.styleMask & NSWindowStyleMaskFullScreen) return NO;
  NSRect content = [window.contentView convertRect:window.contentView.bounds toView:nil];
  if (point.y < NSMaxY(content) || point.y > NSHeight(window.frame) || point.x < 0 || point.x > NSWidth(window.frame)) return NO;
  for (NSNumber *kind in @[@(NSWindowCloseButton), @(NSWindowMiniaturizeButton), @(NSWindowZoomButton), @(NSWindowDocumentIconButton)]) {
    NSButton *button = [window standardWindowButton:(NSWindowButton)kind.integerValue];
    if (button && !button.isHidden && NSPointInRect(point, NSInsetRect([button convertRect:button.bounds toView:nil], -2, -2))) return NO;
  }
  return YES;
}

// AppKit's title row in these windows passes its clicks to Electron's content view, which ignores double-clicks, so
// only the toolbar below it zoomed the window (beta finding F-031). One monitor serves every configured window.
static void watchTitleRow() {
  static id monitor = nil;
  if (monitor) return;
  monitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskLeftMouseDown handler:^NSEvent *(NSEvent *event) {
    NSWindow *window = event.window;
    if (event.clickCount != 2 || (event.modifierFlags & NSEventModifierFlagControl) || !window) return event;
    ImageFlowToolbarDrag *drag = nil;
    for (NSView *view in window.contentView.subviews) if ([view isKindOfClass:ImageFlowToolbarDrag.class]) drag = (ImageFlowToolbarDrag *)view;
    if (!drag || !inBlankTitleRow(window, event.locationInWindow)) return event;
    [drag performTitleBarAction];
    return nil;
  }];
}

// Electron exposes its NSView, but not AppKit's centered document-title layout.
// Keep the real title/proxy button: AppKit continues to own its path menu and dragging.
static NSWindow *windowArgument(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  void *bytes = nullptr;
  size_t length = 0;
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 1 || napi_get_buffer_info(env, args[0], &bytes, &length) != napi_ok || length != sizeof(void *)) {
    napi_throw_type_error(env, nullptr, "Expected Electron's native NSView handle.");
    return nil;
  }
  if (![NSThread isMainThread]) {
    napi_throw_error(env, nullptr, "Configure the document header on the main thread.");
    return nil;
  }
  void *pointer = nullptr;
  std::memcpy(&pointer, bytes, sizeof(pointer));
  NSWindow *window = ((__bridge NSView *)pointer).window;
  if (!window) {
    napi_throw_error(env, nullptr, "The document view has no window.");
    return nil;
  }
  return window;
}

static napi_value configure(napi_env env, napi_callback_info info) {
  NSWindow *window = windowArgument(env, info);
  if (!window) return nullptr;
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
  if (!dragView(window)) {
    ImageFlowToolbarDrag *drag = [[ImageFlowToolbarDrag alloc] initWithFrame:window.contentView.bounds];
    drag.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    drag.regions = @[];
    [window.contentView addSubview:drag positioned:NSWindowAbove relativeTo:nil];
  }
  watchTitleRow();
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static napi_value setDragRegions(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  // The first argument is validated using the same native-handle checks.
  NSWindow *window = windowArgument(env, info);
  if (!window) return nullptr;
  bool array = false;
  uint32_t length = 0;
  if (argc != 2 || napi_is_array(env, args[1], &array) != napi_ok || !array ||
      napi_get_array_length(env, args[1], &length) != napi_ok || length > 128) {
    napi_throw_type_error(env, nullptr, "Expected toolbar rectangles.");
    return nullptr;
  }
  NSMutableArray<NSValue *> *regions = [NSMutableArray arrayWithCapacity:length];
  for (uint32_t index = 0; index < length; ++index) {
    napi_value rect;
    napi_get_element(env, args[1], index, &rect);
    double numbers[4];
    const char *keys[] = {"x", "y", "width", "height"};
    for (int key = 0; key < 4; ++key) {
      napi_value value;
      if (napi_get_named_property(env, rect, keys[key], &value) != napi_ok ||
          napi_get_value_double(env, value, &numbers[key]) != napi_ok) {
        napi_throw_type_error(env, nullptr, "Expected numeric toolbar coordinates.");
        return nullptr;
      }
    }
    [regions addObject:[NSValue valueWithRect:NSMakeRect(numbers[0], numbers[1], numbers[2], numbers[3])]];
  }
  ImageFlowToolbarDrag *drag = dragView(window);
  drag.regions = regions;
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static napi_value initialize(napi_env env, napi_value exports) {
  napi_value function;
  napi_create_function(env, "configure", NAPI_AUTO_LENGTH, configure, nullptr, &function);
  napi_set_named_property(env, exports, "configure", function);
  napi_create_function(env, "setDragRegions", NAPI_AUTO_LENGTH, setDragRegions, nullptr, &function);
  napi_set_named_property(env, exports, "setDragRegions", function);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
