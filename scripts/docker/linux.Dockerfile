# Сборка wpx для Linux в контейнере (из Windows, macOS или любого Linux):
#   docker build -t wpx-linux -f scripts/docker/linux.Dockerfile scripts/docker
#   docker run --rm -v "$PWD:/host:ro" -v "$PWD/dist-linux:/out" wpx-linux
# Ubuntu 22.04 — самая старая поддерживаемая glibc: AppImage запустится и на новых.
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential curl wget file git ca-certificates pkg-config libssl-dev rsync xdg-utils \
      libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal
ENV PATH=/root/.cargo/bin:$PATH CARGO_TARGET_DIR=/target

COPY build.sh /usr/local/bin/wpx-build
RUN chmod +x /usr/local/bin/wpx-build
WORKDIR /work
CMD ["wpx-build"]
