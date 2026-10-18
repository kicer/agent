FROM node:22-slim

# libssl3: officecli is a .NET self-contained binary and hard-requires libssl.
# ICU is NOT needed: DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1 disables globalization.
# curl: the entrypoint fetches the officecli binary at FIRST boot (image intentionally
# does NOT vendor the binary -> nothing to pre-run after clone, `docker compose up` is the whole entry).
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends libssl3 ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Zero npm deps: node shim (server.js + watch.js + gateway.js).
# scripts/entrypoint.sh downloads the pinned officecli into /opt/officecli (named volume
# `officecli-bin`, cached across restarts; sha256 verified every boot, GitHub -> gh-proxy fallback)
# then execs CMD. /opt/officecli goes first in PATH so the shim still spawns bare `officecli`.
COPY package.json server.js watch.js gateway.js ./
COPY scripts/entrypoint.sh /app/scripts/entrypoint.sh
RUN chmod +x /app/scripts/entrypoint.sh

ENV PATH=/opt/officecli:${PATH}
ENV DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1
ENV OFFICE_WORKSPACE=/workspace/tasks
ENV PORT=3000

EXPOSE 3000

ENTRYPOINT ["/app/scripts/entrypoint.sh"]
CMD ["node", "server.js"]
