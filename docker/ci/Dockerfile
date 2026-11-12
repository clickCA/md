# md CI builder image — Ubuntu 24.04 with Tauri v2 Linux build prerequisites
# and the pinned Rust toolchain (1.99.1 — keep in sync with rust-toolchain.toml).
#
# Why bake the deps into an image instead of `sudo apt-get install` per run?
#   1. `apt-get update` on every CI run is slow and depends on the network being
#      healthy exactly at run time; here it runs once at image build time.
#   2. Ubuntu 24.04 is the base the `ubuntu-latest` runner used at the time of
#      this decision; keep this older base even if GH bumps the runner —
#      building on the oldest glibc you support is the Tauri guidance.
#   3. One definition of "what Linux deps the build needs" instead of an apt
#      block copy-pasted into every workflow (ci.yml, release.yml).
#
# Consumed by .github/workflows/ci.yml and .github/workflows/release.yml as the
# job `container`. Built & pushed by .github/workflows/docker-ci.yml (on main,
# when docker/** changes) or locally via `make docker-ci`.

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Etc/UTC

# WebKitGTK's post-install can prompt for the timezone; DEBIAN_FRONTEND +
# TZ keep the build non-interactive.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        # Tauri v2 Linux prerequisites (exactly what CI used to apt-get)
        libwebkit2gtk-4.1-dev \
        libgtk-3-dev \
        libayatana-appindicator3-dev \
        librsvg2-dev \
        libxdo-dev \
        # HTTPS + native build toolchain
        libssl-dev \
        build-essential \
        # bundler tools the Ubuntu runner image already ships but a bare
        # ubuntu:24.04 does not (deb + rpm + AppImage bundles)
        patchelf \
        rpm \
        libfuse2t64 \
        # everyday tooling
        curl \
        wget \
        file \
        git \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Rust toolchain, baked so the CI jobs don't re-download ~300 MB per run.
# The pin matches rust-toolchain.toml (channel 1.99.1) — bump both in the same
# commit; dtolnay/rust-toolchain@1.99.1 in the workflows then becomes a fast
# no-op (toolchain + components already present).
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH="/usr/local/cargo/bin:${PATH}"
RUN set -eux; \
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
        | sh -s -- -y --no-modify-path --profile minimal --default-toolchain 1.99.1; \
    chmod -R a+w "$RUSTUP_HOME" "$CARGO_HOME"; \
    rustup component add rustfmt clippy; \
    rustc --version; cargo --version

# Actions defaults `run` to `sh` inside a container; match the hosted-runner
# experience by making bash the shell.
ENV SHELL=/bin/bash
