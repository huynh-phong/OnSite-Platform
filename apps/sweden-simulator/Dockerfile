FROM node:20-alpine AS ui
WORKDIR /repo/apps/web
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci
COPY apps/web/ ./
RUN npx vite build --mode legacy

FROM node:20-alpine AS build
WORKDIR /app
COPY apps/sweden-simulator/package.json apps/sweden-simulator/package-lock.json ./
RUN npm ci
COPY apps/sweden-simulator/tsconfig.json apps/sweden-simulator/tsconfig.build.json ./
COPY apps/sweden-simulator/src ./src
RUN npm run build

FROM node:20-alpine
ENV NODE_ENV=production
ENV SIM_UI_DIR=/app/ui
WORKDIR /app
COPY apps/sweden-simulator/package.json apps/sweden-simulator/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=ui /repo/apps/web/dist/legacy ./ui
COPY apps/sweden-simulator/migrations ./migrations
COPY apps/sweden-simulator/seed ./seed
USER node
CMD ["node", "dist/server.js"]
