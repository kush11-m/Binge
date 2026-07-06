FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3002
ENV UPLOAD_DIR=/data/uploads

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN mkdir -p /data/uploads

EXPOSE 3002

CMD ["node", "server.js"]
