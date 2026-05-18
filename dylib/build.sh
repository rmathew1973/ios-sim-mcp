#!/usr/bin/env bash
# Build the ios-sim-mcp Layer 2 dylib for the iOS Simulator.
#
# Output: dylib/build/libios-sim-mcp.dylib (universal: arm64 + x86_64)
# Target: iOS Simulator runtime (iOS 14+)

set -euo pipefail
cd "$(dirname "$0")"

OUT_DIR="build"
OUT_NAME="libios-sim-mcp.dylib"
SRC="ios_sim_mcp_dylib.m"

mkdir -p "$OUT_DIR"

build_slice() {
    local arch="$1"
    local out="$OUT_DIR/${OUT_NAME}.${arch}"
    echo "→ compiling $arch slice"
    xcrun -sdk iphonesimulator clang \
        -arch "$arch" \
        -target "${arch}-apple-ios14.0-simulator" \
        -dynamiclib \
        -fmodules \
        -fobjc-arc \
        -Wall -Wextra \
        -O2 \
        -install_name "@rpath/$OUT_NAME" \
        -framework Foundation \
        -framework UIKit \
        -o "$out" \
        "$SRC"
}

build_slice arm64
# x86_64 build is optional; uncomment if you need Intel-sim support.
# build_slice x86_64

# If both slices built, lipo into a universal binary; otherwise just rename.
if [ -f "$OUT_DIR/${OUT_NAME}.x86_64" ]; then
    echo "→ lipo universal"
    xcrun lipo -create \
        "$OUT_DIR/${OUT_NAME}.arm64" \
        "$OUT_DIR/${OUT_NAME}.x86_64" \
        -output "$OUT_DIR/$OUT_NAME"
    rm "$OUT_DIR/${OUT_NAME}.arm64" "$OUT_DIR/${OUT_NAME}.x86_64"
else
    mv "$OUT_DIR/${OUT_NAME}.arm64" "$OUT_DIR/$OUT_NAME"
fi

echo
echo "Built: $(pwd)/$OUT_DIR/$OUT_NAME"
xcrun lipo -info "$OUT_DIR/$OUT_NAME" 2>/dev/null || file "$OUT_DIR/$OUT_NAME"
