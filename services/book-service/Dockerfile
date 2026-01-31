FROM node:18-alpine

WORKDIR /usr/src/app

# Copy shared packages
COPY packages/protos ./packages/protos

# Setup Service
WORKDIR /usr/src/app/services/book-service
COPY services/book-service/package*.json ./
RUN npm install
COPY services/book-service/ .

EXPOSE 3000 50052
CMD ["npm", "start"]
