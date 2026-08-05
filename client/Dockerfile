FROM oven/bun:1-alpine AS deps

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1-alpine AS build

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1

# NEXT_PUBLIC_* variables are inlined into the client bundle at build time, not
# read at runtime. Pointing this at a different SFU means rebuilding the image.
ARG NEXT_PUBLIC_SFU_URL
ENV NEXT_PUBLIC_SFU_URL=$NEXT_PUBLIC_SFU_URL

RUN bun run build

FROM oven/bun:1-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
# Without this Next binds to localhost inside the container and the proxy cannot reach it.
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=build /app/public ./public
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static

# The image carries the standalone bundle only, so bun runs server.js directly —
# no node_modules and no Next CLI in the runtime layer.
USER bun
EXPOSE 3000
CMD ["bun", "run", "server.js"]
