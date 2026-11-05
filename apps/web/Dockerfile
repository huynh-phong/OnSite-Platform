FROM node:20-alpine AS build
WORKDIR /app
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci
COPY apps/web/ ./
RUN npx vite build --mode web && npx tsc -p tsconfig.server.json

FROM node:20-alpine
ENV NODE_ENV=production
ENV WEB_STATIC_DIR=/app/static
WORKDIR /app
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/dist/web ./static
USER node
CMD ["node", "dist-server/index.js"]
