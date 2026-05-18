// ios-sim-mcp Layer 2 dylib — Phase 2a (proof of life)
//
// Loaded into target apps via DYLD_INSERT_LIBRARIES (set by simctl through
// SIMCTL_CHILD_DYLD_INSERT_LIBRARIES). The constructor runs before main(),
// emits an os_log line that Layer 3 can observe, and exits.
//
// Future phases will:
//   - 2b: open a Unix socket and serve JSON-Lines RPC
//   - 2c: walk UIView hierarchy on demand
//   - 2d: install a URLProtocol interceptor to capture network
//   - 2e: stand up a JSContext for in-process eval

#import <Foundation/Foundation.h>
#import <os/log.h>
#import <unistd.h>

#define IOS_SIM_MCP_SUBSYSTEM "com.hmbsoftware.ios-sim-mcp"

static os_log_t ios_sim_mcp_log(void) {
    static os_log_t log = NULL;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        log = os_log_create(IOS_SIM_MCP_SUBSYSTEM, "lifecycle");
    });
    return log;
}

__attribute__((constructor))
static void ios_sim_mcp_init(void) {
    @autoreleasepool {
        os_log_t log = ios_sim_mcp_log();
        pid_t pid = getpid();
        NSString *processName = [[NSProcessInfo processInfo] processName] ?: @"(unknown)";
        NSString *bundleId    = [[NSBundle mainBundle] bundleIdentifier] ?: @"(no bundle)";
        NSString *bundlePath  = [[NSBundle mainBundle] bundlePath] ?: @"(no path)";

        os_log(log, "ios-sim-mcp dylib loaded pid=%{public}d process=%{public}@ bundle=%{public}@",
               pid, processName, bundleId);
        os_log_debug(log, "ios-sim-mcp dylib bundle_path=%{public}@", bundlePath);
    }
}
