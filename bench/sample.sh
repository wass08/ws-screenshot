#!/bin/sh
# usage: sample.sh <container> <intervalSec>  -> prints mem, chromium procs, zombies, browser instances
c=$1; iv=${2:-10}
while docker inspect -f '{{.State.Running}}' "$c" >/dev/null 2>&1; do
  mem=$(docker stats --no-stream --format '{{.MemUsage}}' "$c" | cut -d/ -f1)
  p=$(docker exec "$c" sh -c 'echo "$(ps -eo comm | grep -c chrom) $(ps -eo stat | grep -c ^Z) $(ps -eo args | grep -c "[c]hromium.*--remote-debugging")"' 2>/dev/null)
  echo "$(date +%H:%M:%S) mem=$mem chromeProcs/zombies/browsers=$p"
  sleep "$iv"
done
