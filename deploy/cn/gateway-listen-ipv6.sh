#!/bin/sh
# deploy/cn/gateway-listen-ipv6.sh — adds the gateway's IPv6 listener only when
# the kernel has IPv6 (WP-76).
#
# Installed by deploy/cn/Dockerfile.gateway as
# /docker-entrypoint.d/15-goapply-listen-ipv6.sh; the nginx image's entrypoint
# runs it before nginx starts. deploy/cn/nginx.conf includes
# /tmp/nginx-listen.d/*.conf, so on a node booted with ipv6.disable=1 (some
# Aliyun images) the gateway serves IPv4 instead of failing on `listen [::]`
# with "Address family not supported" and crash-looping. Same check as the
# official image's 10-listen-on-ipv6-by-default.sh, which only edits the
# default.conf this kit replaces.
#
# RA_NGINX_LISTEN_DIR and RA_IF_INET6 exist for the tests
# (__tests__/deploy/deployKit.test.ts); leave them unset in the image.

set -eu

listen_dir="${RA_NGINX_LISTEN_DIR:-/tmp/nginx-listen.d}"
if_inet6="${RA_IF_INET6:-/proc/net/if_inet6}"

mkdir -p "$listen_dir"
rm -f "$listen_dir/ipv6.conf"

if [ -f "$if_inet6" ]; then
  echo "listen [::]:8080 ipv6only=on;" > "$listen_dir/ipv6.conf"
  echo "goapply-gateway: IPv6 available; listening on [::]:8080 and 0.0.0.0:8080"
else
  echo "goapply-gateway: no IPv6 in this kernel ($if_inet6 missing); listening on IPv4 only"
fi
