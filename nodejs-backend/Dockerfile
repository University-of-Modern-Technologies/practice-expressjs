FROM node:22-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
# Neither the schema nor the Prisma runner is in this layer, so the postinstall
# hook would have nothing to generate from. The build stage runs the generation
# itself, once both are copied.
RUN npm ci --ignore-scripts

FROM dependencies AS build
COPY tsconfig.json tsconfig.build.json ./
COPY prisma ./prisma
COPY scripts ./scripts
COPY src ./src
RUN npm run build

FROM build AS production-deps
RUN npm prune --omit=dev

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup --system app && adduser --system --ingroup app app
COPY --from=production-deps --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --chown=app:app package.json ./package.json
USER app
EXPOSE 3000
CMD ["node", "dist/server.js"]
