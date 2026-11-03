FROM mwader/static-ffmpeg:9.0.2-1@sha256:f5d100184884eb3e82b0eb14bb5ebf98da99826ac824989720297fb9ef21c822 AS ffmpeg

FROM node:26.13.0-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39
COPY --from=ffmpeg /ffmpeg /ffprobe /usr/local/bin/

WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev
COPY src ./src

ARG TIMELAPSE_REVISION=unknown
ENV TIMELAPSE_REVISION=$TIMELAPSE_REVISION
ENV NODE_ENV=production
ENV TIMELAPSE_DATA_DIR=/data
USER node
ENTRYPOINT ["node", "src/cli.ts"]
