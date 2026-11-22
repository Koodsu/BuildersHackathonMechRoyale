# Build from the repo root:  docker build --platform linux/amd64 -t my-bot .
# The match runs it with no network, a read-only root (writable /tmp), 1 CPU, 512 MB, uid 65534, and the map at /arena.
# Base image pinned by digest (finalists are rebuilt); the bot has no other dependencies.
FROM node:24.15.0-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d
WORKDIR /bot
COPY package.json main.ts mechfight.ts ./
COPY src ./src
# One CPU is all the match gives us: Node's helper threads (garbage collection, compilers) then only
# compete with the bot for it and stall answers, so everything runs on the one thread.
ENTRYPOINT ["node", "--single-threaded", "--max-semi-space-size=32", "--disable-warning=ExperimentalWarning", "/bot/main.ts"]
