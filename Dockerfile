FROM node:22-alpine@sha256:dbcedd8aeab47fbc0f4dd4bffa55b7c3c729a707875968d467aaaea42d6225af

WORKDIR /usr/src/app

# Copy package manifests and Prisma schema first
COPY package*.json ./
COPY prisma ./prisma

# Install all deps (incl. dev) so prisma CLI is available
RUN npm ci

# Copy the rest
COPY . .

# Trim dev deps for a smaller runtime image
RUN npm prune --omit=dev

ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start"]
