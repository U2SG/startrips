# Build from the repository root:
#   docker build -f routing-builder/Dockerfile .
# The context must be the root so the country-access profiles can be copied.

# The exact pinned OSRM runtime used by scripts/qa-routing-profiles.mjs. A host
# that cannot pull ghcr.io reliably may pass a locally loaded copy of the same
# image (see deploy/README.md).
ARG OSRM_IMAGE=ghcr.io/project-osrm/osrm-backend@sha256:c29a50d67b9be17d10773fa2b52bb045ee3fbb8f42e5f9d1c671ce0d9bb21f37

# Same Node image as the API, so a host that builds the API already has it.
FROM node:22-bookworm-slim AS node-runtime

FROM ${OSRM_IMAGE}

# Copy only the Node binary: no package-manager network access at build time.
# Node bundles its own CA roots for the Overpass HTTPS request. The check below
# fails the build if the OSRM base cannot run a glibc Node binary.
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
RUN node --version

COPY deploy/routing-profiles/walking.lua deploy/routing-profiles/cycling.lua deploy/routing-profiles/country-access.geojson /profiles/
COPY routing-builder/server.mjs routing-builder/corridor.mjs routing-builder/graph-store.mjs routing-builder/overpass.mjs routing-builder/errors.mjs /app/

ENV ROUTING_BUILDER_DATA_DIR=/data \
    ROUTING_BUILDER_PROFILES_DIR=/profiles \
    ROUTING_BUILDER_PORT=8080
VOLUME ["/data"]
EXPOSE 8080
WORKDIR /app
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health').then((r)=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT []
CMD ["node", "/app/server.mjs"]
