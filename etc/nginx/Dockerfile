FROM nginx:1.27-alpine

ARG STACK=nodejs

RUN rm -f /etc/nginx/conf.d/default.conf
COPY ${STACK}.conf /etc/nginx/conf.d/default.conf
