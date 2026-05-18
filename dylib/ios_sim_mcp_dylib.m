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
#import <os/log.h>
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
