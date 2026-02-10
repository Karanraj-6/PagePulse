# Build stage
FROM node:18-alpine AS builder

WORKDIR /usr/src/app

COPY services/notification-service/package*.json ./
RUN npm install

COPY services/notification-service/ ./
COPY packages/protos ./packages/protos

RUN npm run build

# Production stage
FROM node:18-alpine

WORKDIR /usr/src/app

ENV NODE_ENV=production

COPY --from=builder /usr/src/app/dist ./dist
COPY --from=builder /usr/src/app/packages/protos ./packages/protos
COPY --from=builder /usr/src/app/package-lock.json ./
COPY services/notification-service/package.json ./

RUN npm ci --omit=dev

EXPOSE 3000

CMD ["node", "dist/index.js"]
