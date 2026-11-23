FROM directus/directus:11.17.4

USER root
COPY package.json package-lock.json /opt/schema-loader/
RUN cd /opt/schema-loader && npm ci --omit=dev \
    && mkdir -p /directus/schema-state \
    && chown node:node /directus/schema-state

COPY --chown=node:node scripts/ /opt/schema-loader/scripts/
COPY --chown=node:node schemas/ /directus/schemas/
COPY --chown=node:node policies/ /directus/policies/
COPY --chown=node:node seeds/ /directus/seeds/
COPY --chown=node:node entrypoint.sh /opt/schema-loader/entrypoint.sh

USER node
CMD ["sh", "/opt/schema-loader/entrypoint.sh"]
