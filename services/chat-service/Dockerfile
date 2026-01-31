FROM node:18-alpine

WORKDIR /usr/src/app

# Copy shared packages (if needed in future, currently consistent with others)
COPY packages/protos ./packages/protos

# Setup Service
WORKDIR /usr/src/app/services/chat-service
COPY services/chat-service/package*.json ./
RUN npm install
COPY services/chat-service/ .

EXPOSE 3000
CMD ["npm", "start"]
