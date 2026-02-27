# monitor-icecast

Monitors an Icecast stream and exposes Prometheus metrics.

Connects to the stream, pipes audio through ffmpeg for peak analysis, and auto-reconnects on failure or stall.

## Metrics

| Metric | Type | Description |
|---|---|---|
| `icecast_up` | gauge | Connection status (0/1) |
| `icecast_download_rate_bytes_per_second` | gauge | Stream throughput |
| `icecast_audio_peak_dbfs{channel}` | gauge | Audio peak level in dBFS (1s window) |
| `icecast_reconnect_attempts_total` | counter | Cumulative reconnect count |
| `icecast_process_start_time_seconds` | gauge | Process start time (unix epoch) |

## Usage

```sh
deno run --allow-net --allow-run --allow-env monitor.ts https://radio.example/stream.mp3
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `ICECAST_URL` | — | Stream URL (or pass as first arg) |
| `METRICS_PORT` | `9101` | Prometheus scrape port |
| `RECONNECT_DELAY_MS` | `3000` | Delay before reconnecting |
| `STALL_TIMEOUT_MS` | `10000` | Abort if no data received within this window |

## Docker

```sh
cp .env.example .env
# edit .env with your stream URL
docker compose up -d
```

Metrics available at `http://<container>:9101/metrics`.

## Systemd (user unit)

The install script will prompt for your stream URL and configure the unit:

```sh
./install.sh
systemctl --user start icecast-monitor
journalctl --user -u icecast-monitor -f
```

To change the stream URL later, edit `~/.config/systemd/user/icecast-monitor.service` and restart:

```sh
systemctl --user daemon-reload
systemctl --user restart icecast-monitor
```

## Requirements

- Deno 2+
- ffmpeg


## License

Copyright 2026 Radio Dreyeckland

This project is licensed under either of

 * Apache License, Version 2.0, ([LICENSE-APACHE](LICENSE-APACHE) or
   http://www.apache.org/licenses/LICENSE-2.0)
 * MIT license ([LICENSE-MIT](LICENSE-MIT) or
   http://opensource.org/licenses/MIT)

at your option.
