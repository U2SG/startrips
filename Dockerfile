FROM node:22-bookworm-slim AS app-base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable \
    && corepack prepare pnpm@10.17.1 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
COPY patches ./patches
RUN pnpm install --frozen-lockfile

COPY . .

FROM app-base AS frontend-build

ARG VITE_ATLAS_MAP_STYLE_URL
ENV VITE_ATLAS_MAP_STYLE_URL=$VITE_ATLAS_MAP_STYLE_URL
ARG VITE_ATLAS_PMTILES_URL
ENV VITE_ATLAS_PMTILES_URL=$VITE_ATLAS_PMTILES_URL
ARG VITE_ATLAS_PMTILES_GLYPHS_URL
ENV VITE_ATLAS_PMTILES_GLYPHS_URL=$VITE_ATLAS_PMTILES_GLYPHS_URL

RUN npm ci --prefix mobile/soc --ignore-scripts \
    && NODE_OPTIONS=--max-old-space-size=1536 npm --prefix mobile/soc run export:web -- --max-workers 1 \
    && pnpm build \
    && mkdir -p dist/soc && cp -a mobile/soc/dist/. dist/soc/ \
    && cp node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs dist/assets/maplibre-gl-worker.mjs \
    && cp node_modules/maplibre-gl/dist/maplibre-gl-shared.mjs dist/assets/maplibre-gl-shared.mjs

FROM app-base AS api

ENV NODE_ENV=production
EXPOSE 8787

RUN mkdir -p /app/data/soc && chown -R node:node /app/data

USER node

CMD ["node", "--import", "tsx", "server/index.ts"]

FROM caddy:2.11.4-alpine AS web

COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=frontend-build /app/dist /srv
