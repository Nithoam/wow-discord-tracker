FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src/ src/

RUN mkdir -p data

CMD ["npx", "tsx", "src/index.ts"]
