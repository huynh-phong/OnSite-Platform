FROM node:20-alpine AS build
WORKDIR /app
COPY apps/onsite-local-se/package.json apps/onsite-local-se/package-lock.json ./
RUN npm ci
COPY apps/onsite-local-se/tsconfig.json apps/onsite-local-se/tsconfig.build.json ./
COPY apps/onsite-local-se/src ./src
RUN npm run build

FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY apps/onsite-local-se/package.json apps/onsite-local-se/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY apps/onsite-local-se/migrations ./migrations
COPY apps/onsite-local-se/seed ./seed
USER node
CMD ["node", "dist/server.js"]
