FROM node:18-alpine

WORKDIR /usr/src/app

# Copy shared packages
COPY packages/protos ./packages/protos

# Setup Service
WORKDIR /usr/src/app/services/auth-service
COPY services/auth-service/package*.json ./
RUN npm install
COPY services/auth-service/ .

EXPOSE 3000 50051
CMD ["npm", "start"]
