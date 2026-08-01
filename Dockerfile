FROM node:24-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 57332

# Containers opt in to an externally reachable listener. Native installs stay
# loopback-only unless the operator makes the same explicit choice.
ENV WEASLEY_DEEPMIND_HOST=0.0.0.0

CMD ["node", "server.js"]
