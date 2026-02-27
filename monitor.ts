#!/usr/bin/env -S deno run --allow-net --allow-run --allow-env

const STREAM_URL = Deno.env.get("ICECAST_URL") ?? Deno.args[0];
const METRICS_PORT = parseInt(Deno.env.get("METRICS_PORT") ?? "9101");
const RECONNECT_DELAY_MS = parseInt(Deno.env.get("RECONNECT_DELAY_MS") ?? "3000");
const STALL_TIMEOUT_MS = parseInt(Deno.env.get("STALL_TIMEOUT_MS") ?? "10000");
const STREAM_STATUS_PAGE = Deno.env.get("STREAM_STATUS_PAGE") ?? "";
const LISTENER_POLL_MS = parseInt(Deno.env.get("LISTENER_POLL_MS") ?? "15000");

if (!STREAM_URL) {
  console.error("Usage: monitor.ts <icecast-url>");
  console.error("  env: ICECAST_URL, METRICS_PORT (default 9101), RECONNECT_DELAY_MS (default 3000), STALL_TIMEOUT_MS (default 10000)");
  Deno.exit(1);
}

// --- metrics state ---

let connected = 0;
let downloadRate = 0; // bytes/sec
let peakL = -Infinity; // dBFS
let peakR = -Infinity;
let reconnectAttempts = 0;
const processStartTime = Date.now() / 1000;

// listener stats from status-json.xsl
interface ListenerStats {
  current: number;
  peak: number;
}
let listenersByStream: Map<string, ListenerStats> = new Map();

// rate tracking
let bytesThisWindow = 0;
let lastRateCalc = Date.now();

setInterval(() => {
  const now = Date.now();
  const elapsed = (now - lastRateCalc) / 1000;
  if (elapsed > 0) {
    downloadRate = bytesThisWindow / elapsed;
    bytesThisWindow = 0;
    lastRateCalc = now;
  }
}, 2000);

// --- prometheus endpoint ---

Deno.serve({ port: METRICS_PORT, onListen: ({ port }) => {
  console.log(`metrics on :${port}/metrics`);
}}, (req) => {
  if (new URL(req.url).pathname !== "/metrics") {
    return new Response("see /metrics\n", { status: 302, headers: { location: "/metrics" } });
  }
  const body = [
    "# HELP icecast_up Connection status (0=down, 1=up)",
    "# TYPE icecast_up gauge",
    `icecast_up ${connected}`,
    "",
    "# HELP icecast_download_rate_bytes_per_second Stream download rate",
    "# TYPE icecast_download_rate_bytes_per_second gauge",
    `icecast_download_rate_bytes_per_second ${downloadRate.toFixed(1)}`,
    "",
    "# HELP icecast_audio_peak_left_dbfs Audio peak level left channel in dBFS",
    "# TYPE icecast_audio_peak_left_dbfs gauge",
    `icecast_audio_peak_left_dbfs ${isFinite(peakL) ? peakL.toFixed(2) : "NaN"}`,
    "",
    "# HELP icecast_audio_peak_right_dbfs Audio peak level right channel in dBFS",
    "# TYPE icecast_audio_peak_right_dbfs gauge",
    `icecast_audio_peak_right_dbfs ${isFinite(peakR) ? peakR.toFixed(2) : "NaN"}`,
    "",
    "# HELP icecast_reconnect_attempts_total Total reconnection attempts",
    "# TYPE icecast_reconnect_attempts_total counter",
    `icecast_reconnect_attempts_total ${reconnectAttempts}`,
    "",
    "# HELP icecast_process_start_time_seconds Start time of the process since unix epoch",
    "# TYPE icecast_process_start_time_seconds gauge",
    `icecast_process_start_time_seconds ${processStartTime.toFixed(3)}`,
    "",
    ...listenerMetrics(),
  ].join("\n");
  return new Response(body, { headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" } });
});

// --- stream + ffmpeg pipeline ---

async function monitor() {
  while (true) {
    try {
      await runStream();
    } catch (e) {
      console.error("stream error:", (e as Error).message ?? e);
    }
    connected = 0;
    downloadRate = 0;
    peakL = -Infinity;
    peakR = -Infinity;
    reconnectAttempts++;
    console.log(`reconnecting in ${RECONNECT_DELAY_MS}ms (attempt #${reconnectAttempts})...`);
    await delay(RECONNECT_DELAY_MS);
  }
}

async function runStream() {
  const abort = new AbortController();

  console.log(`connecting to ${STREAM_URL}`);
  const resp = await fetch(STREAM_URL, {
    headers: { "icy-metadata": "0", "user-agent": "monitor-icecast/1.0" },
    signal: abort.signal,
  });
  if (!resp.ok || !resp.body) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
  }

  const contentType = resp.headers.get("content-type") ?? "";
  console.log(`connected, content-type: ${contentType}`);
  connected = 1;

  // stall watchdog: abort if no data received within timeout
  let lastChunkAt = Date.now();
  const watchdog = setInterval(() => {
    if (Date.now() - lastChunkAt > STALL_TIMEOUT_MS) {
      console.error(`no data for ${STALL_TIMEOUT_MS}ms, aborting`);
      abort.abort();
    }
  }, 1000);

  // figure out input format hint for ffmpeg
  let inputFmt: string[] = [];
  if (contentType.includes("ogg") || contentType.includes("vorbis") || contentType.includes("opus")) {
    inputFmt = ["-f", "ogg"];
  } else if (contentType.includes("mpeg") || contentType.includes("mp3")) {
    inputFmt = ["-f", "mp3"];
  } else if (contentType.includes("aac")) {
    inputFmt = ["-f", "aac"];
  }

  // spawn ffmpeg: read from stdin, output astats peak levels per 1s window
  const ffmpeg = new Deno.Command("ffmpeg", {
    args: [
      "-hide_banner", "-loglevel", "info",
      ...inputFmt,
      "-i", "pipe:0",
      "-af", "astats=metadata=1:reset=1,ametadata=mode=print",
      "-f", "null", "-",
    ],
    stdin: "piped",
    stdout: "null",
    stderr: "piped",
  }).spawn();

  // parse ffmpeg stderr for peak metadata
  const parseTask = parseFfmpegStderr(ffmpeg.stderr);

  // pipe stream data to ffmpeg stdin, counting bytes
  const writer = ffmpeg.stdin.getWriter();
  try {
    for await (const chunk of resp.body) {
      lastChunkAt = Date.now();
      bytesThisWindow += chunk.byteLength;
      try {
        await writer.write(chunk);
      } catch {
        break;
      }
    }
  } finally {
    clearInterval(watchdog);
    try { writer.close(); } catch { /* ignore */ }
  }

  await parseTask;
  const status = await ffmpeg.status;
  if (!status.success) {
    throw new Error(`ffmpeg exited ${status.code}`);
  }
}

async function parseFfmpegStderr(stderr: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stderr) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      parsePeakLine(line);
    }
  }
}

function parsePeakLine(line: string) {
  // lines look like: [Parsed_ametadata_1 @ 0x...] lavfi.astats.1.Peak_level=-4.50
  const idx = line.indexOf("lavfi.astats.");
  if (idx === -1) return;
  const kv = line.slice(idx);
  const eq = kv.indexOf("=");
  if (eq === -1) return;
  const key = kv.slice(0, eq);
  const val = parseFloat(kv.slice(eq + 1));
  if (isNaN(val)) return;

  if (key === "lavfi.astats.1.Peak_level" || key === "lavfi.astats.Overall.Peak_level") {
    peakL = val;
  }
  if (key === "lavfi.astats.2.Peak_level") {
    peakR = val;
  }
  // mono streams: mirror to both channels from Overall
  if (key === "lavfi.astats.Overall.Peak_level" && !isFinite(peakR)) {
    peakR = val;
  }
}

// --- listener stats from icecast status page ---

function sanitizeMount(listenurl: string): string {
  try {
    const path = new URL(listenurl).pathname;
    return path.replace(/^\//, "").replace(/[^a-zA-Z0-9_]/g, "_");
  } catch {
    return listenurl.replace(/[^a-zA-Z0-9_]/g, "_");
  }
}

function listenerMetrics(): string[] {
  if (listenersByStream.size === 0) return [];
  const lines: string[] = [];

  lines.push("# HELP icecast_listeners_current Current listener count");
  lines.push("# TYPE icecast_listeners_current gauge");
  let combinedCurrent = 0;
  for (const [mount, stats] of listenersByStream) {
    lines.push(`icecast_listeners_current{stream="${mount}"} ${stats.current}`);
    combinedCurrent += stats.current;
  }
  lines.push(`icecast_listeners_combined_current ${combinedCurrent}`);
  lines.push("");

  lines.push("# HELP icecast_listeners_peak Peak listener count");
  lines.push("# TYPE icecast_listeners_peak gauge");
  let combinedPeak = 0;
  for (const [mount, stats] of listenersByStream) {
    lines.push(`icecast_listeners_peak{stream="${mount}"} ${stats.peak}`);
    combinedPeak += stats.peak;
  }
  lines.push(`icecast_listeners_combined_peak ${combinedPeak}`);
  lines.push("");

  return lines;
}

async function pollListeners() {
  if (!STREAM_STATUS_PAGE) return;
  console.log(`polling listeners from ${STREAM_STATUS_PAGE} every ${LISTENER_POLL_MS}ms`);
  while (true) {
    try {
      const resp = await fetch(STREAM_STATUS_PAGE);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json();
      const sources = json?.icestats?.source;
      if (!sources) throw new Error("no icestats.source in response");

      const sourceList = Array.isArray(sources) ? sources : [sources];
      const updated = new Map<string, ListenerStats>();
      for (const src of sourceList) {
        const mount = sanitizeMount(src.listenurl ?? src.server_name ?? "unknown");
        updated.set(mount, {
          current: src.listeners ?? 0,
          peak: src.listener_peak ?? 0,
        });
      }
      listenersByStream = updated;
    } catch (e) {
      console.error("listener poll error:", (e as Error).message ?? e);
    }
    await delay(LISTENER_POLL_MS);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

pollListeners();
monitor();
