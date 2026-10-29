# Leak / load test

Compares memory and leftover Chromium processes between two images.

```sh
node bench/testsite.js &                      # test pages on :8099 (ok, slow, popup, heavy)
docker run -d --name wss --memory 3g -p 13080:3000 ghcr.io/wass08/ws-screenshot:1.2.0-fix1
./bench/sample.sh wss 15 > sample.log &       # mem, chromium procs, zombies, browser instances
node bench/load.js http://localhost:13080 300 6 80,10,10,0   # total, concurrency, mix ok,slow,popup,heavy
```

About 45s after the load ends, a healthy image is back to 0 Chromium processes.
`/heavy` allocates ~200MB/s per tab and will trigger OOM kills under a tight memory limit.
