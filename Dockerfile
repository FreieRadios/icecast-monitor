FROM denoland/deno:debian

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY monitor.ts .

EXPOSE 9101

ENTRYPOINT ["deno", "run", "--allow-net", "--allow-run", "--allow-env", "monitor.ts"]
