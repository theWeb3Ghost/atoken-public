FROM node:20-slim
RUN apt-get update && apt-get install -y python3 python3-pip python3-venv && \
    pip3 install --no-cache-dir --break-system-packages scikit-learn numpy
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY train ./train
RUN mkdir -p /app/data
CMD ["node", "src/index.js"]
