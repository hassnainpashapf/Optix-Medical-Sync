# Optix Medical Sync (hospital) — one Node 24 process, SQLite files in /data (mount a volume there)
FROM node:24-alpine
WORKDIR /app
COPY package.json server.mjs index.html ./
COPY lib ./lib
COPY site ./site
COPY assets ./assets
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/data TRUST_PROXY=1 SECURE_COOKIES=1
VOLUME /data
EXPOSE 3000
CMD ["node", "server.mjs"]
