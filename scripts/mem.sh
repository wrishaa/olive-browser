#!/bin/bash
# resident memory of a running olive (dev or packaged), per process type
ps -axo rss=,command= | grep -E "olive-browser-mac/node_modules/electron/dist|Olive.app/Contents" | grep -v grep | awk '
{ rss=$1/1024; t="main"; if ($0 ~ /Renderer/) t="renderer"; else if ($0 ~ /GPU/ || $0 ~ /gpu-process/) t="gpu"; else if ($0 ~ /Helper/) t="utility"; s[t]+=rss; n[t]++; tot+=rss }
END { for (k in s) printf "%-9s %2d procs %7.1f MB\n", k, n[k], s[k]; printf "total        %7.1f MB\n", tot }'
