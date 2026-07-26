#!/usr/bin/env bash
set -euo pipefail

action="${1:-status}"
case "$action" in
    start)
        systemctl --user start llama-swap.service
        ;;
    stop)
        systemctl --user stop llama-swap.service llama-proxy.service
        ;;
    restart)
        systemctl --user restart llama-proxy.service llama-swap.service
        ;;
    status)
        systemctl --user --no-pager --full status llama-proxy.service llama-swap.service
        ss -lntp | awk 'NR == 1 || /:8080|:8081|:8082/'
        ;;
    *)
        echo "Usage: $0 {start|stop|restart|status}" >&2
        exit 2
        ;;
esac
