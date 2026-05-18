// ios-sim-mcp Layer 2 dylib — Phase 2b (Unix socket + JSON-Lines RPC)
//
// Loaded into target apps via DYLD_INSERT_LIBRARIES (set by simctl through
// SIMCTL_CHILD_DYLD_INSERT_LIBRARIES). On load:
//   1. emits an os_log lifecycle line (Phase 2a)
//   2. binds /tmp/ios-sim-mcp-<bundle-id>.sock and spawns an accept loop
//   3. serves JSON-Lines RPC: one {"id","method","params"} per line in,
//      one {"id","result"} or {"id","error"} per line out.
//
// Builtin methods:
//   ping → {pong, server_ts_ms}
//   info → {pid, process_name, bundle_id, bundle_path, uptime_s, phase}
//
// Future phases register more methods:
//   2c view_tree, view_hit_test
//   2d network_start/stop/tail, network_get_body
//   2e eval_js
//
// Safety rules (DO NOT REGRESS):
//   - Never crash the host app. Everything in @try; protect against SIGPIPE.
//   - Constructor returns ASAP — accept loop runs on a background queue.
//   - UIKit touches must dispatch_sync(dispatch_get_main_queue(), ...) (n/a in 2b).

#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <JavaScriptCore/JavaScriptCore.h>
#import <os/log.h>
#import <objc/runtime.h>
#include <unistd.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>

#define IOS_SIM_MCP_SUBSYSTEM "com.hmbsoftware.ios-sim-mcp"

#pragma mark - Logging

static os_log_t ism_log(void) {
    static os_log_t log = NULL;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ log = os_log_create(IOS_SIM_MCP_SUBSYSTEM, "lifecycle"); });
    return log;
}

static os_log_t ism_rpc_log(void) {
    static os_log_t log = NULL;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ log = os_log_create(IOS_SIM_MCP_SUBSYSTEM, "rpc"); });
    return log;
}

#pragma mark - Method registry

typedef NSDictionary *(^IsmMethod)(NSDictionary *params);

static NSMutableDictionary<NSString *, IsmMethod> *ism_methods = nil;
static dispatch_queue_t ism_methods_queue = NULL;

static void ism_register_method(NSString *name, IsmMethod block) {
    dispatch_sync(ism_methods_queue, ^{
        if (!ism_methods) ism_methods = [NSMutableDictionary dictionary];
        ism_methods[name] = [block copy];
    });
}

static IsmMethod ism_lookup_method(NSString *name) {
    __block IsmMethod method = nil;
    dispatch_sync(ism_methods_queue, ^{ method = ism_methods[name]; });
    return method;
}

static NSArray<NSString *> *ism_method_names(void) {
    __block NSArray<NSString *> *names = nil;
    dispatch_sync(ism_methods_queue, ^{ names = [ism_methods.allKeys sortedArrayUsingSelector:@selector(compare:)]; });
    return names ?: @[];
}

#pragma mark - Socket I/O

static NSString *ism_socket_path_for_bundle(NSString *bundleId) {
    NSCharacterSet *bad = [NSCharacterSet characterSetWithCharactersInString:@"/\\:?*\"<>| "];
    NSString *safe = [[bundleId componentsSeparatedByCharactersInSet:bad] componentsJoinedByString:@"_"];
    return [NSString stringWithFormat:@"/tmp/ios-sim-mcp-%@.sock", safe];
}

static BOOL ism_write_all(int fd, const void *buf, size_t len) {
    const uint8_t *p = (const uint8_t *)buf;
    size_t remaining = len;
    while (remaining > 0) {
        ssize_t n = write(fd, p, remaining);
        if (n < 0) {
            if (errno == EINTR) continue;
            return NO;
        }
        if (n == 0) return NO;
        p += n;
        remaining -= (size_t)n;
    }
    return YES;
}

static void ism_send_response(int fd, NSDictionary *response) {
    @try {
        NSError *err = nil;
        NSData *data = [NSJSONSerialization dataWithJSONObject:response options:0 error:&err];
        if (!data) {
            os_log_error(ism_rpc_log(), "encode failed: %{public}@", err);
            return;
        }
        if (!ism_write_all(fd, data.bytes, data.length)) return;
        const char nl = '\n';
        ism_write_all(fd, &nl, 1);
    } @catch (NSException *e) {
        os_log_error(ism_rpc_log(), "send_response exception: %{public}@", e.reason);
    }
}

static void ism_dispatch_line(int fd, NSData *line) {
    NSError *err = nil;
    id parsed = [NSJSONSerialization JSONObjectWithData:line options:0 error:&err];
    if (![parsed isKindOfClass:[NSDictionary class]]) {
        ism_send_response(fd, @{@"id": [NSNull null], @"error": @"malformed request: not a JSON object"});
        return;
    }
    NSDictionary *req = parsed;
    id reqId = req[@"id"] ?: [NSNull null];
    NSString *method = req[@"method"];
    NSDictionary *params = req[@"params"];
    if (![method isKindOfClass:[NSString class]]) {
        ism_send_response(fd, @{@"id": reqId, @"error": @"missing or non-string method"});
        return;
    }
    if (params && ![params isKindOfClass:[NSDictionary class]]) params = nil;

    IsmMethod handler = ism_lookup_method(method);
    if (!handler) {
        ism_send_response(fd, @{
            @"id": reqId,
            @"error": [NSString stringWithFormat:@"unknown method: %@", method],
            @"available_methods": ism_method_names(),
        });
        return;
    }

    NSDictionary *result = nil;
    NSString *errorText = nil;
    @try {
        result = handler(params ?: @{});
    } @catch (NSException *e) {
        errorText = [NSString stringWithFormat:@"%@: %@", e.name, e.reason];
        os_log_error(ism_rpc_log(), "method %{public}@ threw: %{public}@", method, errorText);
    }
    if (errorText) {
        ism_send_response(fd, @{@"id": reqId, @"error": errorText});
    } else {
        ism_send_response(fd, @{@"id": reqId, @"result": result ?: @{}});
    }
}

static void ism_serve_connection(int fd) {
    NSMutableData *buffer = [NSMutableData data];
    uint8_t chunk[4096];
    while (1) {
        ssize_t n = read(fd, chunk, sizeof(chunk));
        if (n < 0) {
            if (errno == EINTR) continue;
            break;
        }
        if (n == 0) break;
        [buffer appendBytes:chunk length:(NSUInteger)n];

        while (1) {
            const uint8_t *bytes = buffer.bytes;
            NSUInteger len = buffer.length;
            NSUInteger newline = NSNotFound;
            for (NSUInteger i = 0; i < len; i++) {
                if (bytes[i] == '\n') { newline = i; break; }
            }
            if (newline == NSNotFound) break;
            NSData *line = [buffer subdataWithRange:NSMakeRange(0, newline)];
            [buffer replaceBytesInRange:NSMakeRange(0, newline + 1) withBytes:NULL length:0];
            if (line.length > 0) {
                @autoreleasepool { ism_dispatch_line(fd, line); }
            }
        }
    }
    close(fd);
}

static int ism_listen_fd = -1;

static void ism_accept_loop(void) {
    dispatch_queue_t conn_queue = dispatch_queue_create("com.hmbsoftware.ios-sim-mcp.conn",
                                                        DISPATCH_QUEUE_CONCURRENT);
    while (1) {
        int conn = accept(ism_listen_fd, NULL, NULL);
        if (conn < 0) {
            if (errno == EINTR) continue;
            os_log_error(ism_log(), "accept() failed: errno=%d", errno);
            break;
        }
        int yes = 1;
        setsockopt(conn, SOL_SOCKET, SO_NOSIGPIPE, &yes, sizeof(yes));
        dispatch_async(conn_queue, ^{
            @autoreleasepool { ism_serve_connection(conn); }
        });
    }
}

static BOOL ism_start_server(NSString *path) {
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) {
        os_log_error(ism_log(), "socket() failed: errno=%d", errno);
        return NO;
    }

    // Unlink any stale socket from a previous launch of this bundle.
    unlink(path.UTF8String);

    struct sockaddr_un addr = {0};
    addr.sun_family = AF_UNIX;
    const char *cpath = path.UTF8String;
    if (strlen(cpath) >= sizeof(addr.sun_path)) {
        os_log_error(ism_log(), "socket path too long: %{public}@", path);
        close(fd);
        return NO;
    }
    strncpy(addr.sun_path, cpath, sizeof(addr.sun_path) - 1);

    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        os_log_error(ism_log(), "bind(%{public}@) failed: errno=%d", path, errno);
        close(fd);
        return NO;
    }
    chmod(cpath, 0600);

    if (listen(fd, 4) < 0) {
        os_log_error(ism_log(), "listen() failed: errno=%d", errno);
        close(fd);
        unlink(cpath);
        return NO;
    }

    ism_listen_fd = fd;
    dispatch_queue_t accept_queue = dispatch_queue_create("com.hmbsoftware.ios-sim-mcp.accept",
                                                          DISPATCH_QUEUE_SERIAL);
    dispatch_async(accept_queue, ^{ ism_accept_loop(); });
    return YES;
}

#pragma mark - UIKit helpers (main-thread only)

static UIResponder *ism_find_first_responder_in_view(UIView *view) {
    if ([view isFirstResponder]) return view;
    for (UIView *sub in view.subviews) {
        UIResponder *r = ism_find_first_responder_in_view(sub);
        if (r) return r;
    }
    return nil;
}

static NSArray<UIWindow *> *ism_all_windows(void) {
    NSMutableArray<UIWindow *> *out = [NSMutableArray array];
    if (@available(iOS 13.0, *)) {
        for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
            if ([scene isKindOfClass:[UIWindowScene class]]) {
                [out addObjectsFromArray:((UIWindowScene *)scene).windows];
            }
        }
    }
    // Pre-13 fallback / belt-and-suspenders. Some apps still vend non-scene windows.
    #pragma clang diagnostic push
    #pragma clang diagnostic ignored "-Wdeprecated-declarations"
    NSArray<UIWindow *> *legacy = UIApplication.sharedApplication.windows;
    #pragma clang diagnostic pop
    for (UIWindow *w in legacy) if (![out containsObject:w]) [out addObject:w];
    return out;
}

static UIResponder *ism_find_first_responder(void) {
    NSArray<UIWindow *> *windows = ism_all_windows();
    // Prefer the key window — that's where focus actually lives.
    for (UIWindow *w in windows) {
        if (w.isKeyWindow) {
            UIResponder *r = ism_find_first_responder_in_view(w);
            if (r) return r;
        }
    }
    for (UIWindow *w in windows) {
        UIResponder *r = ism_find_first_responder_in_view(w);
        if (r) return r;
    }
    return nil;
}

#pragma mark - JSExport protocols for core classes (Layer 2e)

// JSC only exposes ObjC methods/properties to JS when the class conforms to a
// JSExport-derived protocol. We add categories for the most useful classes so
// callers can write `app.windows[0].rootViewController.title` style code.

// JSExport sees @property declarations as JS value-access (no parens). It sees
// plain method declarations as JS-callable functions. We use @property for
// getters so callers can write `bundle.bundleIdentifier` not
// `bundle.bundleIdentifier()`.

@protocol ISMBundleExport <JSExport>
@property (readonly, copy)   NSString     *bundleIdentifier;
@property (readonly, copy)   NSString     *bundlePath;
@property (readonly, copy)   NSDictionary *infoDictionary;
@end
@interface NSBundle (ISMExport) <ISMBundleExport> @end
@implementation NSBundle (ISMExport) @end

@protocol ISMProcessInfoExport <JSExport>
@property (readonly, copy) NSString     *processName;
@property (readonly)       int           processIdentifier;
@property (readonly, copy) NSString     *hostName;
@property (readonly, copy) NSString     *operatingSystemVersionString;
@property (readonly, copy) NSDictionary *environment;
@end
@interface NSProcessInfo (ISMExport) <ISMProcessInfoExport> @end
@implementation NSProcessInfo (ISMExport) @end

@protocol ISMUserDefaultsExport <JSExport>
- (id)objectForKey:(NSString *)key;
- (NSString *)stringForKey:(NSString *)key;
- (BOOL)boolForKey:(NSString *)key;
- (NSInteger)integerForKey:(NSString *)key;
- (double)doubleForKey:(NSString *)key;
- (NSArray *)arrayForKey:(NSString *)key;
- (NSDictionary *)dictionaryForKey:(NSString *)key;
- (void)setObject:(id)value forKey:(NSString *)key;
- (void)setBool:(BOOL)value forKey:(NSString *)key;
- (void)setInteger:(NSInteger)value forKey:(NSString *)key;
- (void)setDouble:(double)value forKey:(NSString *)key;
- (void)removeObjectForKey:(NSString *)key;
- (BOOL)synchronize;
@end
@interface NSUserDefaults (ISMExport) <ISMUserDefaultsExport> @end
@implementation NSUserDefaults (ISMExport) @end

@protocol ISMPasteboardExport <JSExport>
@property (nonatomic, copy) NSString *string;
@end
@interface UIPasteboard (ISMExport) <ISMPasteboardExport> @end
@implementation UIPasteboard (ISMExport) @end

@protocol ISMApplicationExport <JSExport>
@property (readonly, copy) NSArray  *windows;
@property (readonly)       NSInteger applicationState;
@end
@interface UIApplication (ISMExport) <ISMApplicationExport> @end
@implementation UIApplication (ISMExport) @end

@protocol ISMViewExport <JSExport>
@property (readonly, copy) NSArray *subviews;
@property (readonly)       UIView  *superview;
@property (nonatomic)      CGRect   frame;
@property (nonatomic)      CGRect   bounds;
@property (nonatomic)      CGFloat  alpha;
@property (nonatomic, getter=isHidden) BOOL hidden;
@property (nonatomic)      NSInteger tag;
@property (nonatomic, copy) NSString *accessibilityIdentifier;
@property (nonatomic, copy) NSString *accessibilityLabel;
@property (nonatomic, copy) NSString *accessibilityValue;
@property (nonatomic, getter=isUserInteractionEnabled) BOOL userInteractionEnabled;
@property (readonly)       BOOL      isFirstResponder;
@property (readonly)       UIWindow *window;
@end
@interface UIView (ISMExport) <ISMViewExport> @end
@implementation UIView (ISMExport) @end

@protocol ISMWindowExport <ISMViewExport>
@property (readonly)       UIViewController *rootViewController;
@property (readonly)       BOOL              isKeyWindow;
@end
@interface UIWindow (ISMExport) <ISMWindowExport> @end
@implementation UIWindow (ISMExport) @end

@protocol ISMViewControllerExport <JSExport>
@property (nonatomic, copy) NSString          *title;
@property (readonly)        UIView            *view;
@property (readonly)        UIViewController  *presentedViewController;
@property (readonly)        UIViewController  *presentingViewController;
@property (readonly)        UIViewController  *parentViewController;
@property (readonly, copy)  NSArray           *childViewControllers;
@property (readonly)        BOOL               isViewLoaded;
@end
@interface UIViewController (ISMExport) <ISMViewControllerExport> @end
@implementation UIViewController (ISMExport) @end

@protocol ISMLabelExport <ISMViewExport>
@property (nonatomic, copy) NSString *text;
@end
@interface UILabel (ISMExport) <ISMLabelExport> @end
@implementation UILabel (ISMExport) @end

@protocol ISMButtonExport <ISMViewExport>
@property (readonly, copy) NSString *currentTitle;
@end
@interface UIButton (ISMExport) <ISMButtonExport> @end
@implementation UIButton (ISMExport) @end

@protocol ISMTextFieldExport <ISMViewExport>
@property (nonatomic, copy) NSString *text;
@property (nonatomic, copy) NSString *placeholder;
@end
@interface UITextField (ISMExport) <ISMTextFieldExport> @end
@implementation UITextField (ISMExport) @end

@protocol ISMTextViewExport <ISMViewExport>
@property (nonatomic, copy) NSString *text;
@end
@interface UITextView (ISMExport) <ISMTextViewExport> @end
@implementation UITextView (ISMExport) @end

#pragma mark - JavaScriptCore eval bridge (Layer 2e)

// A single persistent JSContext lives for the life of the host process. State
// (variables, functions defined via eval_js) persists across calls so callers
// can build up helper libraries interactively. eval_js_reset throws it away
// and rebuilds with the same global bridges.
//
// Everything runs on the main queue: JS code can touch UIKit safely, and we
// share the same main-thread discipline as view_tree / paste_text.

static JSContext *ism_js_ctx = nil;

// Forward decls used by bridged helpers below.
static UIView *ism_find_view_by_ax_id(NSString *axId);
static UIView *ism_find_view_by_class(NSString *clsName);
static UIViewController *ism_find_vc_by_class(NSString *clsName);

static void ism_install_js_bridges(JSContext *ctx) {
    ctx[@"app"]         = UIApplication.sharedApplication;
    ctx[@"defaults"]    = [NSUserDefaults standardUserDefaults];
    ctx[@"pasteboard"]  = UIPasteboard.generalPasteboard;
    ctx[@"bundle"]      = [NSBundle mainBundle];
    ctx[@"process"]     = [NSProcessInfo processInfo];
    ctx[@"notif_center"]= [NSNotificationCenter defaultCenter];

    ctx[@"key_window"]       = ^UIWindow * () {
        for (UIWindow *w in ism_all_windows()) if (w.isKeyWindow) return w;
        return ism_all_windows().firstObject;
    };
    ctx[@"all_windows"]      = ^NSArray * () { return ism_all_windows(); };
    ctx[@"first_responder"]  = ^id ()         { return ism_find_first_responder(); };

    ctx[@"find_view_by_ax_id"] = ^UIView * (NSString *axId) { return ism_find_view_by_ax_id(axId); };
    ctx[@"find_view_by_class"] = ^UIView * (NSString *cls)  { return ism_find_view_by_class(cls); };
    ctx[@"find_vc_by_class"]   = ^UIViewController * (NSString *cls) { return ism_find_vc_by_class(cls); };

    ctx[@"post_notification"] = ^(NSString *name, NSDictionary *userInfo) {
        if (![name isKindOfClass:[NSString class]]) return;
        [[NSNotificationCenter defaultCenter] postNotificationName:name
                                                            object:nil
                                                          userInfo:[userInfo isKindOfClass:[NSDictionary class]] ? userInfo : nil];
    };

    ctx[@"log"] = ^(JSValue *msg) {
        os_log(ism_rpc_log(), "js: %{public}@", [msg toString]);
    };

    // Convenience: NSClassFromString in JS, e.g. cls("UILabel").
    ctx[@"cls"] = ^Class (NSString *name) {
        return NSClassFromString(name);
    };
}

static JSContext *ism_get_js_context(void) {
    __block JSContext *ctx = nil;
    dispatch_sync(dispatch_get_main_queue(), ^{
        if (!ism_js_ctx) {
            ism_js_ctx = [[JSContext alloc] init];
            ism_js_ctx.name = @"ios-sim-mcp-eval";
            ism_js_ctx.exceptionHandler = ^(JSContext *c, JSValue *exception) {
                os_log_error(ism_rpc_log(), "js exception: %{public}@", [exception toString]);
                c.exception = exception;
            };
            ism_install_js_bridges(ism_js_ctx);
        }
        ctx = ism_js_ctx;
    });
    return ctx;
}

// Walk all windows once looking for the first UIView matching a predicate.
static UIView *ism_find_view_helper(BOOL (^matches)(UIView *)) {
    for (UIWindow *w in ism_all_windows()) {
        NSMutableArray<UIView *> *stack = [NSMutableArray arrayWithObject:w];
        while (stack.count > 0) {
            UIView *v = stack.lastObject;
            [stack removeLastObject];
            if (matches(v)) return v;
            for (UIView *sub in v.subviews) [stack addObject:sub];
        }
    }
    return nil;
}

static UIView *ism_find_view_by_ax_id(NSString *axId) {
    if (![axId isKindOfClass:[NSString class]] || axId.length == 0) return nil;
    return ism_find_view_helper(^BOOL(UIView *v) {
        return [v.accessibilityIdentifier isEqualToString:axId];
    });
}

static UIView *ism_find_view_by_class(NSString *clsName) {
    Class cls = NSClassFromString(clsName);
    if (!cls) return nil;
    return ism_find_view_helper(^BOOL(UIView *v) {
        return [v isKindOfClass:cls];
    });
}

static UIViewController *ism_find_vc_by_class(NSString *clsName) {
    Class cls = NSClassFromString(clsName);
    if (!cls) return nil;
    for (UIWindow *w in ism_all_windows()) {
        UIViewController *root = w.rootViewController;
        NSMutableArray<UIViewController *> *q = [NSMutableArray arrayWithObject:root];
        while (q.count > 0) {
            UIViewController *vc = q.firstObject;
            [q removeObjectAtIndex:0];
            if ([vc isKindOfClass:cls]) return vc;
            if (vc.presentedViewController) [q addObject:vc.presentedViewController];
            [q addObjectsFromArray:vc.childViewControllers];
        }
    }
    return nil;
}

// Convert a JSValue into a JSON-friendly NSObject, returning its "kind" too.
// For ObjC-bridged objects (NSURL, UIView, etc.) we record class + description
// rather than try to walk the object — the caller can dig deeper via eval_js.
static NSDictionary *ism_coerce_js_value(JSValue *v) {
    if (!v || v.isUndefined) return @{@"kind": @"undefined", @"value": [NSNull null]};
    if (v.isNull)            return @{@"kind": @"null",      @"value": [NSNull null]};
    if (v.isBoolean)         return @{@"kind": @"boolean",   @"value": @([v toBool])};
    if (v.isNumber)          return @{@"kind": @"number",    @"value": @([v toDouble])};
    if (v.isString)          return @{@"kind": @"string",    @"value": [v toString]};
    if (v.isArray) {
        id raw = [v toArray];
        if (!raw) raw = @[];
        if ([NSJSONSerialization isValidJSONObject:raw]) return @{@"kind": @"array", @"value": raw};
        // ObjC objects inside; describe each.
        NSMutableArray *out = [NSMutableArray array];
        for (id e in raw) [out addObject:[NSString stringWithFormat:@"%@", e]];
        return @{@"kind": @"array_described", @"value": out};
    }
    if (v.isObject) {
        id raw = [v toObject];
        if (raw == nil) return @{@"kind": @"object_null", @"value": [NSNull null]};
        if ([NSJSONSerialization isValidJSONObject:raw]) {
            return @{@"kind": @"object", @"value": raw};
        }
        // ObjC bridge — record class + description.
        return @{
            @"kind": @"objc",
            @"class": NSStringFromClass([raw class]) ?: @"?",
            @"description": [raw description] ?: @"",
        };
    }
    return @{@"kind": @"other", @"value": [v toString] ?: @""};
}

#pragma mark - Network interception (Layer 2d)

// Strategy:
//   1. ISMURLProtocol subclasses NSURLProtocol. canInitWithRequest claims
//      http/https requests (unless marked with our re-entry flag).
//   2. We swizzle +[NSURLSessionConfiguration defaultSessionConfiguration]
//      and +ephemeralSessionConfiguration to prepend ISMURLProtocol to the
//      returned config's protocolClasses. Modern URLSession-based code
//      (Alamofire, URLRequest, SwiftUI AsyncImage, NSURLSession native) all
//      flow through one of these two configs.
//   3. In startLoading we forward via a fresh ephemeral session whose
//      configuration is fetched via the ORIGINAL ephemeral IMP (bypassing
//      the swizzle to break recursion). Plus we set a re-entry flag on the
//      forwarded request so canInitWithRequest declines it even if the
//      original config still has our protocol.
//   4. We push a record into a ring buffer (default 500 records) and store
//      full request/response bodies in side dictionaries keyed by id (capped
//      to max_body_bytes; full bytes available via network_get_body).

static NSMutableArray<NSMutableDictionary *> *ism_net_records = nil;
static NSMutableDictionary<NSNumber *, NSData *> *ism_net_request_bodies = nil;
static NSMutableDictionary<NSNumber *, NSData *> *ism_net_response_bodies = nil;
static NSLock *ism_net_lock = nil;
static int64_t ism_net_next_id = 0;
static NSInteger ism_net_max_records = 500;
static NSInteger ism_net_max_body_bytes = 256 * 1024; // 256 KB
static NSString *ism_net_url_filter = nil; // substring; if non-nil, only matching URLs are recorded
static BOOL ism_net_running = NO;

// Original IMPs captured before swizzling.
static IMP ism_orig_defaultConfig_imp = NULL;
static IMP ism_orig_ephemeralConfig_imp = NULL;

static NSString * const kISMHandledKey = @"com.hmbsoftware.ios-sim-mcp.handled";

static NSString *ism_body_preview_string(NSData *data, NSUInteger maxBytes, BOOL *outIsBinary) {
    if (data.length == 0) return @"";
    NSUInteger n = MIN(data.length, maxBytes);
    NSData *slice = [data subdataWithRange:NSMakeRange(0, n)];
    NSString *s = [[NSString alloc] initWithData:slice encoding:NSUTF8StringEncoding];
    if (s) {
        if (outIsBinary) *outIsBinary = NO;
        // Cap render length so single huge text bodies don't blow JSON response size.
        const NSUInteger maxRenderChars = 8192;
        if (s.length > maxRenderChars) {
            s = [[s substringToIndex:maxRenderChars] stringByAppendingFormat:@"…(+%lu chars)", (unsigned long)(s.length - maxRenderChars)];
        }
        return s;
    }
    if (outIsBinary) *outIsBinary = YES;
    return [NSString stringWithFormat:@"<binary %lu bytes>", (unsigned long)data.length];
}

static BOOL ism_url_passes_filter(NSURL *url) {
    if (!ism_net_url_filter) return YES;
    return [url.absoluteString rangeOfString:ism_net_url_filter options:NSCaseInsensitiveSearch].location != NSNotFound;
}

static int64_t ism_net_record_started(NSURLRequest *request) {
    if (!ism_url_passes_filter(request.URL)) return 0;
    [ism_net_lock lock];
    int64_t recordId = ++ism_net_next_id;
    NSMutableDictionary *rec = [NSMutableDictionary dictionary];
    rec[@"id"] = @(recordId);
    rec[@"url"] = request.URL.absoluteString ?: @"";
    rec[@"method"] = request.HTTPMethod ?: @"GET";
    rec[@"request_headers"] = request.allHTTPHeaderFields ?: @{};
    rec[@"started_at_ms"] = @((long long)([[NSDate date] timeIntervalSince1970] * 1000.0));

    NSData *body = request.HTTPBody;
    if (body) {
        rec[@"request_body_size"] = @(body.length);
        BOOL bin = NO;
        rec[@"request_body_preview"] = ism_body_preview_string(body, (NSUInteger)ism_net_max_body_bytes, &bin);
        rec[@"request_body_binary"] = @(bin);
        rec[@"request_body_truncated"] = @(body.length > (NSUInteger)ism_net_max_body_bytes);
        ism_net_request_bodies[@(recordId)] = body;
    } else if (request.HTTPBodyStream) {
        rec[@"request_body_preview"] = @"(HTTPBodyStream — not captured in 2d)";
        rec[@"request_body_size"] = @-1;
    }

    [ism_net_records addObject:rec];
    while (ism_net_records.count > (NSUInteger)ism_net_max_records) {
        NSMutableDictionary *evicted = ism_net_records.firstObject;
        [ism_net_records removeObjectAtIndex:0];
        NSNumber *evId = evicted[@"id"];
        if (evId) {
            [ism_net_request_bodies removeObjectForKey:evId];
            [ism_net_response_bodies removeObjectForKey:evId];
        }
    }
    [ism_net_lock unlock];
    return recordId;
}

static void ism_net_record_completed(int64_t recordId, NSURLResponse *response, NSData *body, NSDate *startedAt, NSDate *respStartedAt, NSError *error) {
    if (recordId == 0) return;
    [ism_net_lock lock];
    NSMutableDictionary *rec = nil;
    for (NSMutableDictionary *r in ism_net_records) {
        if ([r[@"id"] longLongValue] == recordId) { rec = r; break; }
    }
    if (!rec) { [ism_net_lock unlock]; return; }

    NSDate *now = [NSDate date];
    rec[@"ended_at_ms"] = @((long long)([now timeIntervalSince1970] * 1000.0));
    rec[@"duration_ms"] = @((long long)([now timeIntervalSinceDate:startedAt] * 1000.0));
    if (respStartedAt) {
        rec[@"ttfb_ms"] = @((long long)([respStartedAt timeIntervalSinceDate:startedAt] * 1000.0));
    }

    if ([response isKindOfClass:[NSHTTPURLResponse class]]) {
        NSHTTPURLResponse *http = (NSHTTPURLResponse *)response;
        rec[@"status"] = @(http.statusCode);
        rec[@"response_headers"] = http.allHeaderFields ?: @{};
    }
    if (response.MIMEType) rec[@"mime"] = response.MIMEType;

    if (body) {
        rec[@"response_body_size"] = @(body.length);
        BOOL bin = NO;
        rec[@"response_body_preview"] = ism_body_preview_string(body, (NSUInteger)ism_net_max_body_bytes, &bin);
        rec[@"response_body_binary"] = @(bin);
        rec[@"response_body_truncated"] = @(body.length > (NSUInteger)ism_net_max_body_bytes);
        ism_net_response_bodies[@(recordId)] = body;
    }

    if (error) {
        rec[@"error"] = error.localizedDescription ?: [error description];
        rec[@"error_code"] = @(error.code);
        rec[@"error_domain"] = error.domain ?: @"";
    }
    [ism_net_lock unlock];
}

// ISMURLProtocol -------------------------------------------------------------

@interface ISMURLProtocol : NSURLProtocol <NSURLSessionDataDelegate>
@end

@implementation ISMURLProtocol {
    NSURLSession         *_session;
    NSURLSessionDataTask *_task;
    NSMutableData        *_responseData;
    int64_t               _recordId;
    NSDate               *_startedAt;
    NSDate               *_responseStartedAt;
}

+ (BOOL)canInitWithRequest:(NSURLRequest *)request {
    if ([NSURLProtocol propertyForKey:kISMHandledKey inRequest:request]) return NO;
    NSString *scheme = request.URL.scheme.lowercaseString;
    if (!scheme) return NO;
    return [scheme isEqualToString:@"http"] || [scheme isEqualToString:@"https"];
}

+ (NSURLRequest *)canonicalRequestForRequest:(NSURLRequest *)request { return request; }
+ (BOOL)requestIsCacheEquivalent:(NSURLRequest *)a toRequest:(NSURLRequest *)b { return NO; }

- (void)startLoading {
    _startedAt = [NSDate date];
    _responseData = [NSMutableData data];
    _recordId = ism_net_record_started(self.request);

    NSMutableURLRequest *forward = [self.request mutableCopy];
    [NSURLProtocol setProperty:@YES forKey:kISMHandledKey inRequest:forward];

    // Build a config WITHOUT our protocol to avoid re-entry — call the ORIGINAL
    // ephemeral IMP directly, bypassing our swizzle.
    NSURLSessionConfiguration *config = nil;
    if (ism_orig_ephemeralConfig_imp) {
        config = ((NSURLSessionConfiguration *(*)(Class, SEL))ism_orig_ephemeralConfig_imp)
            ([NSURLSessionConfiguration class], @selector(ephemeralSessionConfiguration));
    } else {
        config = [NSURLSessionConfiguration ephemeralSessionConfiguration];
    }
    // Defensive: strip our protocol in case the original IMP returned a config
    // that includes it (it shouldn't, but be safe).
    NSMutableArray *protos = [config.protocolClasses mutableCopy] ?: [NSMutableArray array];
    [protos removeObject:[ISMURLProtocol class]];
    config.protocolClasses = protos;

    _session = [NSURLSession sessionWithConfiguration:config delegate:self delegateQueue:nil];
    _task = [_session dataTaskWithRequest:forward];
    [_task resume];
}

- (void)stopLoading {
    [_task cancel];
    [_session invalidateAndCancel];
    _session = nil;
    _task = nil;
}

- (void)URLSession:(NSURLSession *)session
          dataTask:(NSURLSessionDataTask *)dataTask
didReceiveResponse:(NSURLResponse *)response
 completionHandler:(void (^)(NSURLSessionResponseDisposition))completionHandler {
    _responseStartedAt = [NSDate date];
    [self.client URLProtocol:self didReceiveResponse:response cacheStoragePolicy:NSURLCacheStorageNotAllowed];
    completionHandler(NSURLSessionResponseAllow);
}

- (void)URLSession:(NSURLSession *)session
          dataTask:(NSURLSessionDataTask *)dataTask
    didReceiveData:(NSData *)data {
    [_responseData appendData:data];
    [self.client URLProtocol:self didLoadData:data];
}

- (void)URLSession:(NSURLSession *)session
              task:(NSURLSessionTask *)task
didCompleteWithError:(NSError *)error {
    ism_net_record_completed(_recordId, task.response, _responseData, _startedAt, _responseStartedAt, error);
    if (error) [self.client URLProtocol:self didFailWithError:error];
    else       [self.client URLProtocolDidFinishLoading:self];
}

@end

// Swizzles for default + ephemeral configs ----------------------------------

static NSURLSessionConfiguration *ism_swizzled_default(Class self, SEL _cmd) {
    NSURLSessionConfiguration *c = ((NSURLSessionConfiguration *(*)(Class, SEL))ism_orig_defaultConfig_imp)(self, _cmd);
    NSMutableArray *cls = [c.protocolClasses mutableCopy] ?: [NSMutableArray array];
    if (![cls containsObject:[ISMURLProtocol class]]) {
        [cls insertObject:[ISMURLProtocol class] atIndex:0];
        c.protocolClasses = cls;
    }
    return c;
}

static NSURLSessionConfiguration *ism_swizzled_ephemeral(Class self, SEL _cmd) {
    NSURLSessionConfiguration *c = ((NSURLSessionConfiguration *(*)(Class, SEL))ism_orig_ephemeralConfig_imp)(self, _cmd);
    NSMutableArray *cls = [c.protocolClasses mutableCopy] ?: [NSMutableArray array];
    if (![cls containsObject:[ISMURLProtocol class]]) {
        [cls insertObject:[ISMURLProtocol class] atIndex:0];
        c.protocolClasses = cls;
    }
    return c;
}

static void ism_install_network_swizzles(void) {
    if (ism_orig_defaultConfig_imp) return; // already installed
    Method m1 = class_getClassMethod([NSURLSessionConfiguration class], @selector(defaultSessionConfiguration));
    if (m1) {
        ism_orig_defaultConfig_imp = method_getImplementation(m1);
        method_setImplementation(m1, (IMP)ism_swizzled_default);
    }
    Method m2 = class_getClassMethod([NSURLSessionConfiguration class], @selector(ephemeralSessionConfiguration));
    if (m2) {
        ism_orig_ephemeralConfig_imp = method_getImplementation(m2);
        method_setImplementation(m2, (IMP)ism_swizzled_ephemeral);
    }
}

static void ism_remove_network_swizzles(void) {
    if (ism_orig_defaultConfig_imp) {
        Method m1 = class_getClassMethod([NSURLSessionConfiguration class], @selector(defaultSessionConfiguration));
        if (m1) method_setImplementation(m1, ism_orig_defaultConfig_imp);
        ism_orig_defaultConfig_imp = NULL;
    }
    if (ism_orig_ephemeralConfig_imp) {
        Method m2 = class_getClassMethod([NSURLSessionConfiguration class], @selector(ephemeralSessionConfiguration));
        if (m2) method_setImplementation(m2, ism_orig_ephemeralConfig_imp);
        ism_orig_ephemeralConfig_imp = NULL;
    }
}

#pragma mark - View introspection helpers (main-thread only)

static NSString *ism_view_text_content(UIView *view) {
    // Prefer the most specific accessor per type. valueForKey would technically
    // work for several of these but is more fragile and has KVC-undefined edge
    // cases on some subclasses.
    if ([view isKindOfClass:[UILabel class]]) return ((UILabel *)view).text;
    if ([view isKindOfClass:[UITextField class]]) return ((UITextField *)view).text;
    if ([view isKindOfClass:[UITextView class]]) return ((UITextView *)view).text;
    if ([view isKindOfClass:[UIButton class]]) {
        UIButton *b = (UIButton *)view;
        return b.currentTitle ?: b.titleLabel.text;
    }
    return nil;
}

static UIViewController *ism_owning_vc_if_root(UIView *view) {
    // Walk the responder chain. If the *first* UIViewController we encounter has
    // `view` as its loaded root view, this view is the VC's root; annotate it.
    UIResponder *r = view.nextResponder;
    while (r) {
        if ([r isKindOfClass:[UIViewController class]]) {
            UIViewController *vc = (UIViewController *)r;
            return (vc.viewIfLoaded == view) ? vc : nil;
        }
        r = r.nextResponder;
    }
    return nil;
}

static NSDictionary *ism_frame_dict(CGRect r) {
    return @{
        @"x": @(r.origin.x),
        @"y": @(r.origin.y),
        @"w": @(r.size.width),
        @"h": @(r.size.height),
    };
}

static NSDictionary *ism_serialize_view(UIView *view,
                                        UIWindow *window,
                                        int depth,
                                        int maxDepth,
                                        BOOL filterVisible,
                                        BOOL includeText,
                                        int *nodeCounter,
                                        int maxNodes,
                                        BOOL *hitCap) {
    if (*hitCap) return nil;
    if (*nodeCounter >= maxNodes) { *hitCap = YES; return nil; }

    if (filterVisible) {
        if (view.isHidden) return nil;
        if (view.alpha < 0.01) return nil;
        if (CGRectIsEmpty(view.bounds)) return nil;
    }

    (*nodeCounter)++;
    NSMutableDictionary *node = [NSMutableDictionary dictionary];
    node[@"v"] = [NSString stringWithFormat:@"v%d", *nodeCounter];
    node[@"class"] = NSStringFromClass([view class]);
    node[@"frame"] = ism_frame_dict([view convertRect:view.bounds toView:window]);

    if (view.alpha < 0.999) node[@"alpha"] = @(view.alpha);
    if (view.isHidden) node[@"hidden"] = @YES;
    if (!view.isUserInteractionEnabled) node[@"interactive"] = @NO;
    if (view.tag != 0) node[@"tag"] = @(view.tag);

    NSString *axId = view.accessibilityIdentifier;
    if (axId.length) node[@"ax_id"] = axId;
    NSString *axLabel = view.accessibilityLabel;
    if (axLabel.length) node[@"ax_label"] = axLabel;
    NSString *axValue = view.accessibilityValue;
    if (axValue.length) node[@"ax_value"] = axValue;

    if (includeText) {
        NSString *text = ism_view_text_content(view);
        if (text.length) node[@"text"] = text;
    }

    UIViewController *vc = ism_owning_vc_if_root(view);
    if (vc) node[@"vc_class"] = NSStringFromClass([vc class]);

    if (depth < maxDepth && view.subviews.count > 0) {
        NSMutableArray *kids = [NSMutableArray array];
        for (UIView *sub in view.subviews) {
            NSDictionary *child = ism_serialize_view(sub, window, depth + 1, maxDepth,
                                                    filterVisible, includeText,
                                                    nodeCounter, maxNodes, hitCap);
            if (child) [kids addObject:child];
            if (*hitCap) break;
        }
        if (kids.count) node[@"children"] = kids;
    }

    return node;
}

#pragma mark - Builtin methods

static void ism_register_builtins(NSString *bundleId, NSString *processName, NSString *bundlePath) {
    pid_t pid = getpid();
    NSDate * const startedAt = [NSDate date];

    ism_register_method(@"ping", ^NSDictionary *(NSDictionary *params) {
        return @{
            @"pong": @YES,
            @"server_ts_ms": @((long long)([[NSDate date] timeIntervalSince1970] * 1000.0)),
            @"echo": params[@"echo"] ?: [NSNull null],
        };
    });

    ism_register_method(@"info", ^NSDictionary *(NSDictionary *params) {
        return @{
            @"pid": @(pid),
            @"process_name": processName ?: @"",
            @"bundle_id": bundleId ?: @"",
            @"bundle_path": bundlePath ?: @"",
            @"uptime_s": @([[NSDate date] timeIntervalSinceDate:startedAt]),
            @"phase": @"2b",
            @"methods": ism_method_names(),
        };
    });

    // paste_text: byte-perfect text input via UIPasteboard + first responder's
    // -paste:. Bypasses iOS keyboard entirely — no autocorrect, no first-letter
    // capitalization, no shifted-symbol HID translation. The MCP's type_text
    // tool auto-routes here when the dylib is loaded.
    //
    // Pre-condition: a text field must already be the first responder (i.e.
    // caller tapped the field first). If not, returns a clear error.
    ism_register_method(@"paste_text", ^NSDictionary *(NSDictionary *params) {
        id textRaw = params[@"text"];
        if (![textRaw isKindOfClass:[NSString class]]) {
            @throw [NSException exceptionWithName:@"BadParams"
                                           reason:@"`text` must be a string"
                                         userInfo:nil];
        }
        NSString *text = textRaw;

        __block BOOL ok = NO;
        __block NSString *errMsg = nil;
        __block NSString *responderClass = nil;

        dispatch_sync(dispatch_get_main_queue(), ^{
            @try {
                UIPasteboard.generalPasteboard.string = text;
                UIResponder *responder = ism_find_first_responder();
                if (!responder) {
                    errMsg = @"no first responder — tap a text field before paste_text";
                    return;
                }
                responderClass = NSStringFromClass([responder class]);
                SEL pasteSel = @selector(paste:);
                if (![responder respondsToSelector:pasteSel]) {
                    errMsg = [NSString stringWithFormat:@"responder %@ does not implement paste:", responderClass];
                    return;
                }
                #pragma clang diagnostic push
                #pragma clang diagnostic ignored "-Warc-performSelector-leaks"
                [responder performSelector:pasteSel withObject:nil];
                #pragma clang diagnostic pop
                ok = YES;
            } @catch (NSException *e) {
                errMsg = [NSString stringWithFormat:@"%@: %@", e.name, e.reason];
            }
        });

        if (!ok) {
            @throw [NSException exceptionWithName:@"PasteFailed"
                                           reason:errMsg ?: @"unknown error"
                                         userInfo:nil];
        }
        return @{
            @"chars": @(text.length),
            @"responder": responderClass ?: @"",
        };
    });

    // view_tree: walks UIWindowScene.windows → root views → subviews recursively
    // on the main queue. Returns per-window trees with class, frame (in window
    // coords), accessibility, text content for known leaf types, and a vc_class
    // annotation when the view is the root view of a UIViewController.
    //
    // Params:
    //   max_depth          (number, default 30)
    //   max_nodes          (number, default 1500) — caps walk to keep responses
    //                      sized; hit_cap=true in response when truncated.
    //   include_invisible  (bool,   default false) — by default skip hidden /
    //                      α≈0 / zero-size views.
    //   include_text       (bool,   default true)  — UILabel/UIButton/etc text.
    ism_register_method(@"view_tree", ^NSDictionary *(NSDictionary *params) {
        int maxDepth = 30, maxNodes = 1500;
        BOOL filterVisible = YES, includeText = YES;
        id v;
        if ((v = params[@"max_depth"])         && [v isKindOfClass:[NSNumber class]]) maxDepth = [v intValue];
        if ((v = params[@"max_nodes"])         && [v isKindOfClass:[NSNumber class]]) maxNodes = [v intValue];
        if ((v = params[@"include_invisible"]) && [v isKindOfClass:[NSNumber class]]) filterVisible = ![v boolValue];
        if ((v = params[@"include_text"])      && [v isKindOfClass:[NSNumber class]]) includeText = [v boolValue];

        __block NSMutableArray *windowsOut = [NSMutableArray array];
        __block int nodeCounter = 0;
        __block BOOL hitCap = NO;

        dispatch_sync(dispatch_get_main_queue(), ^{
            for (UIWindow *window in ism_all_windows()) {
                NSDictionary *root = ism_serialize_view(window, window, 0, maxDepth,
                                                        filterVisible, includeText,
                                                        &nodeCounter, maxNodes, &hitCap);
                if (!root) continue;

                NSMutableDictionary *winDict = [root mutableCopy];
                winDict[@"is_key_window"] = @(window.isKeyWindow);
                UIViewController *rootVC = window.rootViewController;
                if (rootVC) {
                    winDict[@"root_vc_class"] = NSStringFromClass([rootVC class]);
                    UIViewController *deepest = rootVC;
                    while (deepest.presentedViewController) deepest = deepest.presentedViewController;
                    if (deepest != rootVC) {
                        winDict[@"presented_vc_class"] = NSStringFromClass([deepest class]);
                    }
                }
                [windowsOut addObject:winDict];
                if (hitCap) break;
            }
        });

        return @{
            @"windows": windowsOut,
            @"total_nodes": @(nodeCounter),
            @"hit_cap": @(hitCap),
            @"max_nodes": @(maxNodes),
            @"max_depth": @(maxDepth),
        };
    });

    // view_hit_test: returns the topmost view at a window-coord point, plus the
    // full responder chain. Useful for "what does a tap at (x,y) actually hit?"
    // diagnosis when a control isn't reacting to taps as expected.
    ism_register_method(@"view_hit_test", ^NSDictionary *(NSDictionary *params) {
        id xVal = params[@"x"], yVal = params[@"y"];
        if (![xVal isKindOfClass:[NSNumber class]] || ![yVal isKindOfClass:[NSNumber class]]) {
            @throw [NSException exceptionWithName:@"BadParams"
                                           reason:@"x and y must be numbers"
                                         userInfo:nil];
        }
        CGPoint p = CGPointMake([xVal doubleValue], [yVal doubleValue]);

        __block NSDictionary *result = nil;
        dispatch_sync(dispatch_get_main_queue(), ^{
            UIWindow *keyWindow = nil;
            NSArray<UIWindow *> *windows = ism_all_windows();
            for (UIWindow *w in windows) if (w.isKeyWindow) { keyWindow = w; break; }
            if (!keyWindow) keyWindow = windows.firstObject;
            if (!keyWindow) return;

            UIView *hit = [keyWindow hitTest:p withEvent:nil];
            if (!hit) { result = @{@"hit": [NSNull null], @"point": @{@"x": @(p.x), @"y": @(p.y)}}; return; }

            NSMutableArray *chain = [NSMutableArray array];
            UIResponder *r = hit;
            while (r) {
                NSMutableDictionary *e = [NSMutableDictionary dictionary];
                e[@"class"] = NSStringFromClass([r class]);
                if ([r isKindOfClass:[UIView class]]) {
                    UIView *vw = (UIView *)r;
                    e[@"frame"] = ism_frame_dict([vw convertRect:vw.bounds toView:keyWindow]);
                    if (vw.accessibilityIdentifier.length) e[@"ax_id"] = vw.accessibilityIdentifier;
                } else if ([r isKindOfClass:[UIViewController class]]) {
                    e[@"is_vc"] = @YES;
                }
                [chain addObject:e];
                r = r.nextResponder;
            }

            NSString *text = ism_view_text_content(hit);
            CGRect hitFrame = [hit convertRect:hit.bounds toView:keyWindow];
            result = @{
                @"point": @{@"x": @(p.x), @"y": @(p.y)},
                @"hit": @{
                    @"class": NSStringFromClass([hit class]),
                    @"frame": ism_frame_dict(hitFrame),
                    @"ax_id": hit.accessibilityIdentifier ?: @"",
                    @"ax_label": hit.accessibilityLabel ?: @"",
                    @"text": text ?: @"",
                    @"interactive": @(hit.isUserInteractionEnabled),
                    @"alpha": @(hit.alpha),
                },
                @"responder_chain": chain,
            };
        });

        if (!result) @throw [NSException exceptionWithName:@"NoKeyWindow"
                                                   reason:@"no key window available"
                                                 userInfo:nil];
        return result;
    });

    // -------- Network interception RPC (Layer 2d) --------

    ism_register_method(@"network_start", ^NSDictionary *(NSDictionary *params) {
        if (!ism_net_lock) {
            ism_net_lock = [[NSLock alloc] init];
            ism_net_records = [NSMutableArray array];
            ism_net_request_bodies = [NSMutableDictionary dictionary];
            ism_net_response_bodies = [NSMutableDictionary dictionary];
        }
        id v;
        if ((v = params[@"max_records"])    && [v isKindOfClass:[NSNumber class]]) ism_net_max_records = [v integerValue];
        if ((v = params[@"max_body_bytes"]) && [v isKindOfClass:[NSNumber class]]) ism_net_max_body_bytes = [v integerValue];
        if ((v = params[@"filter_url_substring"]) && [v isKindOfClass:[NSString class]] && ((NSString *)v).length > 0) {
            ism_net_url_filter = [v copy];
        } else {
            ism_net_url_filter = nil;
        }
        if (!ism_net_running) {
            [NSURLProtocol registerClass:[ISMURLProtocol class]];
            ism_install_network_swizzles();
            ism_net_running = YES;
        }
        return @{
            @"running": @YES,
            @"max_records": @(ism_net_max_records),
            @"max_body_bytes": @(ism_net_max_body_bytes),
            @"filter_url_substring": ism_net_url_filter ?: [NSNull null],
            @"note": @"URLSession-based traffic (default + ephemeral configs). Existing sessions constructed before start are not retro-fitted.",
        };
    });

    ism_register_method(@"network_stop", ^NSDictionary *(NSDictionary *params) {
        if (ism_net_running) {
            [NSURLProtocol unregisterClass:[ISMURLProtocol class]];
            ism_remove_network_swizzles();
            ism_net_running = NO;
        }
        return @{@"running": @NO};
    });

    ism_register_method(@"network_status", ^NSDictionary *(NSDictionary *params) {
        NSUInteger count = 0;
        if (ism_net_lock) { [ism_net_lock lock]; count = ism_net_records.count; [ism_net_lock unlock]; }
        return @{
            @"running": @(ism_net_running),
            @"records_held": @(count),
            @"next_id": @(ism_net_next_id),
            @"max_records": @(ism_net_max_records),
            @"max_body_bytes": @(ism_net_max_body_bytes),
            @"filter_url_substring": ism_net_url_filter ?: [NSNull null],
        };
    });

    ism_register_method(@"network_tail", ^NSDictionary *(NSDictionary *params) {
        NSInteger n = 50;
        int64_t sinceId = 0;
        BOOL includeHeaders = NO;
        BOOL includePreviews = YES;
        id v;
        if ((v = params[@"n"])               && [v isKindOfClass:[NSNumber class]]) n = [v integerValue];
        if ((v = params[@"since_id"])        && [v isKindOfClass:[NSNumber class]]) sinceId = [v longLongValue];
        if ((v = params[@"include_headers"]) && [v isKindOfClass:[NSNumber class]]) includeHeaders = [v boolValue];
        if ((v = params[@"include_previews"])&& [v isKindOfClass:[NSNumber class]]) includePreviews = [v boolValue];

        NSMutableArray *out = [NSMutableArray array];
        if (ism_net_lock) {
            [ism_net_lock lock];
            // Filter by sinceId, then take last n.
            NSMutableArray *eligible = [NSMutableArray array];
            for (NSDictionary *r in ism_net_records) {
                if ([r[@"id"] longLongValue] > sinceId) [eligible addObject:r];
            }
            NSUInteger start = eligible.count > (NSUInteger)n ? eligible.count - n : 0;
            for (NSUInteger i = start; i < eligible.count; i++) {
                NSDictionary *r = eligible[i];
                if (includeHeaders && includePreviews) {
                    [out addObject:r];
                } else {
                    NSMutableDictionary *m = [r mutableCopy];
                    if (!includeHeaders) {
                        [m removeObjectForKey:@"request_headers"];
                        [m removeObjectForKey:@"response_headers"];
                    }
                    if (!includePreviews) {
                        [m removeObjectForKey:@"request_body_preview"];
                        [m removeObjectForKey:@"response_body_preview"];
                    }
                    [out addObject:m];
                }
            }
            [ism_net_lock unlock];
        }
        return @{
            @"records": out,
            @"running": @(ism_net_running),
        };
    });

    ism_register_method(@"network_get_body", ^NSDictionary *(NSDictionary *params) {
        id idVal = params[@"id"];
        id whichVal = params[@"which"];
        if (![idVal isKindOfClass:[NSNumber class]]) {
            @throw [NSException exceptionWithName:@"BadParams" reason:@"`id` must be a number" userInfo:nil];
        }
        NSString *which = [whichVal isKindOfClass:[NSString class]] ? whichVal : @"response";
        NSNumber *key = idVal;
        NSData *body = nil;
        if (ism_net_lock) {
            [ism_net_lock lock];
            body = [which isEqualToString:@"request"] ? ism_net_request_bodies[key] : ism_net_response_bodies[key];
            [ism_net_lock unlock];
        }
        if (!body) {
            return @{@"found": @NO, @"id": idVal, @"which": which};
        }
        BOOL isBin = NO;
        NSString *preview = ism_body_preview_string(body, body.length, &isBin);
        return @{
            @"found": @YES,
            @"id": idVal,
            @"which": which,
            @"size": @(body.length),
            @"binary": @(isBin),
            @"base64": [body base64EncodedStringWithOptions:0],
            @"text": isBin ? @"" : preview,
        };
    });

    ism_register_method(@"network_clear", ^NSDictionary *(NSDictionary *params) {
        if (ism_net_lock) {
            [ism_net_lock lock];
            [ism_net_records removeAllObjects];
            [ism_net_request_bodies removeAllObjects];
            [ism_net_response_bodies removeAllObjects];
            [ism_net_lock unlock];
        }
        return @{@"cleared": @YES};
    });

    // -------- JS eval bridge (Layer 2e) --------

    // eval_js: runs arbitrary JavaScript in a persistent JSContext bridged to
    // app / key_window() / defaults / pasteboard / bundle / process plus
    // helpers (find_view_by_ax_id, find_vc_by_class, post_notification, log,
    // cls). State persists across calls; use eval_js_reset to clear.
    //
    // Return shape:
    //   ok=true:  {kind, value} where kind ∈ string|number|boolean|null|
    //             undefined|array|object|array_described|objc|other.
    //             For "objc", also: class + description.
    //   ok=false: {exception}.
    // Plus: elapsed_ms.
    ism_register_method(@"eval_js", ^NSDictionary *(NSDictionary *params) {
        id codeVal = params[@"code"];
        if (![codeVal isKindOfClass:[NSString class]]) {
            @throw [NSException exceptionWithName:@"BadParams"
                                           reason:@"`code` must be a string"
                                         userInfo:nil];
        }
        NSString *code = codeVal;

        JSContext *ctx = ism_get_js_context();
        __block JSValue *result = nil;
        __block NSString *exception = nil;
        NSDate *startedAt = [NSDate date];

        dispatch_sync(dispatch_get_main_queue(), ^{
            ctx.exception = nil;
            result = [ctx evaluateScript:code];
            if (ctx.exception) {
                exception = [ctx.exception toString];
                ctx.exception = nil;
            }
        });

        NSTimeInterval elapsed = -[startedAt timeIntervalSinceNow];

        if (exception) {
            return @{
                @"ok": @NO,
                @"exception": exception,
                @"elapsed_ms": @((long long)(elapsed * 1000.0)),
            };
        }
        NSDictionary *coerced = ism_coerce_js_value(result);
        NSMutableDictionary *out = [coerced mutableCopy];
        out[@"ok"] = @YES;
        out[@"elapsed_ms"] = @((long long)(elapsed * 1000.0));
        return out;
    });

    ism_register_method(@"eval_js_reset", ^NSDictionary *(NSDictionary *params) {
        dispatch_sync(dispatch_get_main_queue(), ^{
            ism_js_ctx = nil; // lazily recreated on next eval_js
        });
        return @{@"reset": @YES};
    });

    // network_self_test: verifies the interception path end-to-end by firing
    // a URLSession request from inside the dylib using the (swizzled) default
    // config, then waiting for completion. Useful when the host app makes no
    // network calls of its own during smoke tests.
    ism_register_method(@"network_self_test", ^NSDictionary *(NSDictionary *params) {
        id urlVal = params[@"url"];
        NSString *urlStr = [urlVal isKindOfClass:[NSString class]] ? urlVal : @"https://example.com/";
        NSURL *url = [NSURL URLWithString:urlStr];
        if (!url) @throw [NSException exceptionWithName:@"BadParams" reason:@"invalid url" userInfo:nil];

        if (!ism_net_running) {
            @throw [NSException exceptionWithName:@"NotRunning" reason:@"call network_start first" userInfo:nil];
        }

        NSURLSessionConfiguration *config = [NSURLSessionConfiguration defaultSessionConfiguration];
        NSURLSession *session = [NSURLSession sessionWithConfiguration:config];
        dispatch_semaphore_t sem = dispatch_semaphore_create(0);
        __block NSInteger status = 0;
        __block NSUInteger bodyLen = 0;
        __block NSString *errMsg = nil;
        NSURLSessionDataTask *task = [session dataTaskWithURL:url
                                            completionHandler:^(NSData *data, NSURLResponse *resp, NSError *err) {
            if (err) errMsg = err.localizedDescription;
            if ([resp isKindOfClass:[NSHTTPURLResponse class]]) status = ((NSHTTPURLResponse *)resp).statusCode;
            bodyLen = data.length;
            dispatch_semaphore_signal(sem);
        }];
        [task resume];
        long waited = dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC));
        if (waited != 0) @throw [NSException exceptionWithName:@"Timeout" reason:@"self-test timed out after 10s" userInfo:nil];

        return @{
            @"url": urlStr,
            @"status": @(status),
            @"body_len": @(bodyLen),
            @"error": errMsg ?: @"",
        };
    });
}

#pragma mark - Constructor

__attribute__((constructor))
static void ios_sim_mcp_init(void) {
    @autoreleasepool {
        // SIGPIPE on a closed socket would kill the host app. Ignore it globally;
        // we use SO_NOSIGPIPE per-fd as well for belt-and-suspenders.
        signal(SIGPIPE, SIG_IGN);

        ism_methods_queue = dispatch_queue_create("com.hmbsoftware.ios-sim-mcp.methods",
                                                  DISPATCH_QUEUE_SERIAL);

        os_log_t log = ism_log();
        pid_t pid = getpid();
        NSString *processName = [[NSProcessInfo processInfo] processName] ?: @"(unknown)";
        NSString *bundleId    = [[NSBundle mainBundle] bundleIdentifier] ?: @"";
        NSString *bundlePath  = [[NSBundle mainBundle] bundlePath] ?: @"";

        os_log(log, "ios-sim-mcp dylib loaded pid=%d process=%{public}@ bundle=%{public}@",
               pid, processName, bundleId);

        if (bundleId.length == 0) {
            os_log_error(log, "no bundle id; skipping socket server (likely a helper process)");
            return;
        }

        ism_register_builtins(bundleId, processName, bundlePath);

        NSString *path = ism_socket_path_for_bundle(bundleId);
        if (ism_start_server(path)) {
            os_log(log, "ios-sim-mcp socket listening at %{public}@", path);
        } else {
            os_log_error(log, "ios-sim-mcp socket server failed to start");
        }
    }
}
