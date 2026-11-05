FROM node:20-alpine AS ui
WORKDIR /repo/apps/web
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci
COPY apps/web/ ./
RUN npx vite build --mode central

FROM node:20-alpine AS build
WORKDIR /app
COPY apps/onsite-central/package.json apps/onsite-central/package-lock.json ./
RUN npm ci
COPY apps/onsite-central/tsconfig.json apps/onsite-central/tsconfig.build.json ./
COPY apps/onsite-central/src ./src
RUN npm run build

FROM node:20-alpine
ENV NODE_ENV=production
ENV CENTRAL_UI_DIR=/app/ui
WORKDIR /app
COPY apps/onsite-central/package.json apps/onsite-central/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=ui /repo/apps/web/dist/central ./ui
COPY apps/onsite-central/migrations ./migrations
USER node
CMD ["node", "dist/server.js"]
