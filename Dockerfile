FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.ts svelte.config.js tsconfig.json ./
COPY public ./public
COPY src ./src
COPY server ./server
COPY tests ./tests
RUN npm run check && npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DAILY_USAGE_FILE=/app/usage/daily-usage.json
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/src/review-model.ts ./src/review-model.ts
RUN mkdir -p /app/usage && chown node:node /app/usage
USER node
EXPOSE 8787
CMD ["node", "server/index.ts"]
