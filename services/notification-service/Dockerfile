FROM node:18-alpine
WORKDIR /app
COPY services/notification-service/package*.json ./
RUN npm install
COPY services/notification-service/ .
CMD ["npm", "start"]
