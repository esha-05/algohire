FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npx tsc -p . && mkdir -p /data/certs
CMD ["node", "dist/server.js"]
