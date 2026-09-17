# Synap backend — Cloud Run image.
# Multi-stage so the runtime layer carries no compiler and no dev dependencies.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --include=dev
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npm run build

FROM node:22-slim AS runtime
ENV NODE_ENV=production
# atempo creates a pitch-preserving ASR copy through pipes, without plaintext files.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY fixtures ./fixtures

# Cloud Run injects PORT; the server reads it and defaults to 8080.
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "dist/src/index.js"]
