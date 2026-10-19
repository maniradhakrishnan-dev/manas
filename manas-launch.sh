#!/usr/bin/env bash
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

# Pick the newest compiled binary between release and debug
NEWEST_BIN=""
for b in "$DIR/src-tauri/target/release/manas" "$DIR/src-tauri/target/debug/manas" "$DIR/target/release/manas" "$DIR/target/debug/manas"; do
    if [ -f "$b" ]; then
        if [ -z "$NEWEST_BIN" ] || [ "$b" -nt "$NEWEST_BIN" ]; then
            NEWEST_BIN="$b"
        fi
    fi
done

if [ -n "$NEWEST_BIN" ]; then
    echo "Launching: $NEWEST_BIN"
    exec "$NEWEST_BIN" "$@"
else
    npx @tauri-apps/cli dev
fi
