#!/bin/bash
# google sign-in matrix: cdp port on/off x UA mode. drives accounts.google.com up to the
# password page with a public dummy address (never types a password).
# result per run: password-page (allowed) | rejected ("browser may not be secure") | other
cd "$(dirname "$0")/.."
export OLIVE_PROFILE=gtest
EMAIL=${EMAIL:-test@gmail.com}
O="node bin/olive.mjs"
for cdp in 0 1; do
  for mode in ${MODES:-electron chrome auto}; do
    rm -rf "$HOME/Library/Application Support/Olive-gtest"
    OLIVE_CDP=$cdp OLIVE_UA_MODE=$mode ./scripts/dev-restart.sh 5 >/dev/null
    id=$($O open https://accounts.google.com/ServiceLogin | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
    $O eval $id "document.querySelector('#identifierId').focus(); 1" >/dev/null
    $O cdp $id Input.insertText "{\"text\":\"$EMAIL\"}" >/dev/null
    $O eval $id "document.querySelector('#identifierNext button, #identifierNext').click(); 1" >/dev/null
    sleep 6
    res=$($O eval $id "(() => { const t = document.body.innerText; if (/may not be secure/i.test(t) || /signin\/rejected/.test(location.href)) return 'rejected'; if (document.querySelector('input[type=password]') || /challenge\/pwd/.test(location.href)) return 'password-page'; return 'other: ' + location.pathname + ' | ' + t.split('\n').slice(0,3).join(' / '); })()")
    ua=$($O eval $id "navigator.userAgent.slice(0,40)+'… '+navigator.userAgent.slice(-30)")
    echo "cdp=$cdp ua=$mode -> $res   [$ua]"
  done
done
pkill -f "olive-browser-mac/node_modules/electron/dist"; sleep 1
rm -rf "$HOME/Library/Application Support/Olive-gtest"
