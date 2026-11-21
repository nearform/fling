# Caddy with one DNS provider module, for the wildcard certificate over ACME DNS-01. The module is
# the build argument CADDY_DNS_MODULE (default Cloudflare's); any of github.com/caddy-dns/* works,
# with the matching ACME_DNS_PROVIDER in .env.
ARG CADDY_VERSION=2.10
FROM caddy:${CADDY_VERSION}-builder AS build
ARG CADDY_DNS_MODULE=github.com/caddy-dns/cloudflare
RUN xcaddy build --with "${CADDY_DNS_MODULE}"

FROM caddy:${CADDY_VERSION}
COPY --from=build /usr/bin/caddy /usr/bin/caddy
