// co-watch poc, step 1: watch a video page like a co-viewer would.
// headless chromium (never touches the user's olive), plays the page's <video>, and for `secs` seconds:
//  - samples the video frame ~1/s, keeps a frame only on scene change (or every `keepEvery` s as a heartbeat)
//  - records the video element's audio (video.captureStream -> MediaRecorder, webm/opus) for transcription
//  - grabs page context: title, url, visible text, selection, scroll position, video currentTime per frame
// out: <out>/frames/*.jpg, <out>/audio.webm, <out>/context.json
// usage: node capture.mjs <url> <out> [secs=60] [startAt=0]
import { createRequire } from "module";
import fs from "fs";
import path from "path";
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = require(process.env.PW || "playwright")); }

const [url, out, secsArg, startArg] = process.argv.slice(2);
const secs = +(secsArg || 60), startAt = +(startArg || 0);
const keepEvery = 15; // heartbeat frame even without a scene change
const sceneThresh = +(process.env.CW_SCENE || 0.03); // mean abs luma diff (0..1) on a 32x18 thumbnail
fs.mkdirSync(path.join(out, "frames"), { recursive: true });

const browser = await chromium.launch({ headless: true, ...(process.env.CW_CHANNEL ? { channel: process.env.CW_CHANNEL } : {}), args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36" });
const page = await ctx.newPage();
const audioChunks = [];
await page.exposeBinding("__cwAudio", (_s, b64) => audioChunks.push(Buffer.from(b64, "base64")));
await page.goto(url, { referer: process.env.CW_REFERER || "https://reframe.so/", waitUntil: "domcontentloaded", timeout: 60000 });
// youtube consent wall (eu): accept-all if shown
for (const sel of ['button[aria-label^="Accept all"]', 'button:has-text("Accept all")', 'button:has-text("Reject all")']) {
  const b = page.locator(sel).first();
  if (await b.isVisible({ timeout: 1500 }).catch(() => false)) { await b.click().catch(() => {}); break; }
}
await page.waitForSelector("video", { state: "attached", timeout: 30000 });
console.log("codecs", JSON.stringify(await page.evaluate(() => ({ vp9: MediaSource.isTypeSupported('video/webm; codecs="vp9"'), h264: MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E"'), opus: MediaSource.isTypeSupported('audio/webm; codecs="opus"') }))));
// skip ads if youtube shows one; seek + play
const ready = await page.evaluate(async (startAt) => {
  const v = document.querySelector("video");
  for (let i = 0; i < 60 && (v.readyState < 2 || document.querySelector(".ad-showing")); i++) {
    document.querySelector(".ytp-skip-ad-button, .ytp-ad-skip-button")?.click();
    await new Promise((r) => setTimeout(r, 500));
  }
  if (startAt) v.currentTime = startAt;
  v.muted = false; v.volume = 1;
  await Promise.race([v.play().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
  await new Promise((r) => setTimeout(r, 1500));
  return { readyState: v.readyState, t: v.currentTime, paused: v.paused, w: v.videoWidth, h: v.videoHeight };
}, startAt);
console.log("video", JSON.stringify(ready));

// audio: the element's own stream, so only this tab's media, nothing from the mic or other tabs
const audioInfo = await page.evaluate(() => {
  const v = document.querySelector("video");
  const s = v.captureStream ? v.captureStream() : v.mozCaptureStream();
  const tracks = s.getAudioTracks();
  if (!tracks.length) return { ok: false, why: "no audio track" };
  const rec = new MediaRecorder(new MediaStream(tracks), { mimeType: "audio/webm;codecs=opus" });
  rec.ondataavailable = async (e) => {
    const b = new Uint8Array(await e.data.arrayBuffer());
    let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    window.__cwAudio(btoa(s));
  };
  rec.start(1000); window.__cwRec = rec; window.__cwAudioStart = v.currentTime;
  return { ok: true, tracks: tracks.length, start: v.currentTime };
});
console.log("audio", JSON.stringify(audioInfo));

const frames = [];
let prev = null, lastKept = -1e9, sampled = 0;
const diffs = [];
const t0 = Date.now();
while (Date.now() - t0 < secs * 1000) {
  const tick = Date.now();
  const s = await page.evaluate(() => {
    const v = document.querySelector("video");
    const c = (window.__cwC ||= document.createElement("canvas")); c.width = 32; c.height = 18;
    const g = c.getContext("2d", { willReadFrequently: true });
    let luma = null;
    try { g.drawImage(v, 0, 0, 32, 18); const d = g.getImageData(0, 0, 32, 18).data; luma = []; for (let i = 0; i < d.length; i += 4) luma.push((d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255); } catch (e) { luma = null; }
    const r = v.getBoundingClientRect();
    return { t: v.currentTime, paused: v.paused, luma, rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
  });
  sampled++;
  let diff = 1;
  if (prev && s.luma) diff = s.luma.reduce((a, x, i) => a + Math.abs(x - prev[i]), 0) / s.luma.length;
  diffs.push([+s.t.toFixed(1), +diff.toFixed(4)]);
  const heartbeat = s.t - lastKept >= keepEvery;
  if (diff > sceneThresh || heartbeat) {
    const file = `f${String(frames.length).padStart(3, "0")}-t${s.t.toFixed(1)}.jpg`;
    // a cdp screenshot of the video rect: the same thing olive's GET /tabs/:id/screenshot gives for a background tab
    await page.screenshot({ path: path.join(out, "frames", file), type: "jpeg", quality: 70, clip: s.rect });
    frames.push({ file, t: +s.t.toFixed(1), why: diff > sceneThresh ? `scene ${diff.toFixed(3)}` : "heartbeat" });
    lastKept = s.t;
  }
  if (s.luma) prev = s.luma;
  await page.waitForTimeout(Math.max(0, 1000 - (Date.now() - tick)));
}
const endInfo = await page.evaluate(() => new Promise((res) => {
  const v = document.querySelector("video");
  const r = window.__cwRec; if (!r) return res({ t: v.currentTime });
  r.onstop = () => setTimeout(() => res({ t: v.currentTime, audioStart: window.__cwAudioStart }), 300); r.stop();
}));
await page.waitForTimeout(800);
const pageCtx = await page.evaluate(() => ({
  title: document.title,
  url: location.href,
  selection: String(getSelection() || ""),
  scrollY: scrollY,
  text: document.body.innerText.slice(0, 6000),
}));
fs.writeFileSync(path.join(out, "audio.webm"), Buffer.concat(audioChunks));
const ctxOut = { ...pageCtx, video: ready, audio: { ...audioInfo, bytes: Buffer.concat(audioChunks).length, start: endInfo.audioStart }, end: endInfo.t, secs, sampled, sceneThresh, frames, diffs };
fs.writeFileSync(path.join(out, "context.json"), JSON.stringify(ctxOut, null, 2));
console.log(`sampled ${sampled} frames, kept ${frames.length}, audio ${ctxOut.audio.bytes} bytes, video ${ready.t.toFixed(1)}s -> ${endInfo.t.toFixed(1)}s`);
await page.screenshot({ path: path.join(out, "page.jpg"), type: "jpeg", quality: 60 });
await browser.close();
