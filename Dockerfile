FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

# 登录态存这里；Zeabur 挂持久卷到该路径，重启不丢
VOLUME ["/app/data"]
ENV DATA_DIR=/app/data
ENV PORT=8080

EXPOSE 8080
CMD ["node", "src/server.js"]
