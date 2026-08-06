# syntax=docker/dockerfile:1

# ---- build stage -------------------------------------------------------
# The build needs devDependencies (vite, @react-router/dev), so install the
# full dependency tree here and ship only the compiled output to the runtime.
FROM node:22-alpine AS build
RUN apk add --no-cache openssl
WORKDIR /app

COPY package.json package-lock.json* .npmrc ./
RUN npm ci

COPY . .
RUN npx prisma generate && npm run build

# ---- runtime stage -----------------------------------------------------
FROM node:22-alpine AS runtime
# sqlite ships the CLI used by deploy/backup.sh for consistent online backups.
RUN apk add --no-cache openssl sqlite
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY package.json package-lock.json* .npmrc ./
RUN npm ci --omit=dev && npm cache clean --force

COPY prisma ./prisma
COPY --from=build /app/build ./build
COPY --from=build /app/public ./public

# Generate the client against the pruned node_modules of this stage.
RUN npx prisma generate

# SQLite lives on a mounted volume. Creating the directory here means a fresh
# named volume inherits this ownership, so the unprivileged user can write to it.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME /data

EXPOSE 3000

# `setup` runs `prisma migrate deploy` before the server starts, so schema
# changes are applied automatically on every deploy.
CMD ["npm", "run", "docker-start"]
