#!/bin/bash
# restart the dev build (profile "dev") in the background, log to /tmp/olive-dev.log
cd "$(dirname "$0")/.."
osascript -e 'tell application id "com.github.Electron" to quit' 2>/dev/null
for i in 1 2 3 4 5 6 7 8 9 10; do pgrep -f "olive-browser-mac/node_modules/electron/dist" >/dev/null || break; sleep 0.5; done
pkill -f "olive-browser-mac/node_modules/electron/dist" 2>/dev/null; sleep 1
pkill -9 -f "olive-browser-mac/node_modules/electron/dist" 2>/dev/null
OLIVE_PROFILE=${OLIVE_PROFILE:-dev} nohup ./node_modules/.bin/electron . > /tmp/olive-dev.log 2>&1 &
sleep ${1:-4}
tail -3 /tmp/olive-dev.log
