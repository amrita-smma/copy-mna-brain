# Local development image for the Next.js app.
# For production you'll want a multi-stage build using `next build`; this image
# is tuned for `pnpm dev` with the source mounted from the host.
FROM node:22-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NEXT_TELEMETRY_DISABLED=1

RUN corepack enable

WORKDIR /app

# Everything pnpm checks the lockfile against must be present before install:
# the overrides and patchedDependencies live in pnpm-workspace.yaml (not
# package.json#pnpm), the patches they point at live in patches/, and the
# lockfile has an importer for the data-pipeline workspace package.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY data-pipeline/package.json ./data-pipeline/
RUN pnpm install --frozen-lockfile

COPY . .

EXPOSE 3000

CMD ["pnpm", "dev", "--hostname", "0.0.0.0"]
