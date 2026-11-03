// co-watch poc, step 3: ask the user's own agent about what it just watched.
// builds one turn from the capture: page context + timestamped transcript + the kept frames (as images),
// trimmed to a recent window ("what did he just show?" = the last `windowS` seconds), and runs it through
// claude code (opus) with an identity block, standing in for "send to dj's olive chat in the engine".
// usage: node ask.mjs <out> "<question>" [windowS=90] [identityFile]
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

const [out, question, winArg, idFile] = process.argv.slice(2);
const windowS = +(winArg || 90);
const c = JSON.parse(fs.readFileSync(path.join(out, "context.json"), "utf8"));
const tr = JSON.parse(fs.readFileSync(path.join(out, "audio.json"), "utf8"));
const now = c.end, from = now - windowS;
const a0 = c.audio.start ?? c.video.t; // video time where the recording started
const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const segs = tr.segments.map((s) => ({ t: a0 + s.start, text: s.text.trim() })).filter((s) => s.t >= from);
const frames = c.frames.filter((f) => f.t >= from);
const abs = (f) => path.resolve(out, "frames", f.file);

const identity = idFile && fs.existsSync(idFile)
  ? (fs.readFileSync(idFile, "utf8").match(/> identity v1\.[^\n]*/)?.[0] || "").replace(/^> /, "")
  : "you are the user's own agent.";

const prompt = `${identity}

you are co-watching a video with dj in the olive browser sidebar. you watched it with him: the frames below were sampled from the video element (~1/s, kept on scene change or every 15s) and the transcript is the tab's own audio, transcribed locally. times are video time (m:ss). "now" is ${fmt(now)}.

page: ${c.title}
url: ${c.url.replace(/[?#].*/, "")}

transcript (${fmt(from)} to ${fmt(now)}):
${segs.map((s) => `[${fmt(s.t)}] ${s.text}`).join("\n")}

frames (read each image file with the Read tool before answering):
${frames.map((f) => `[${fmt(f.t)}] ${abs(f)} (${f.why})`).join("\n")}

dj asks: "${question}"

answer in dj's style (lowercase, short, lead with the answer). say what was on screen, name the timestamp(s), and quote the speaker where it helps. if something you say is from a frame vs from the audio, make that clear. no preamble.`;

fs.writeFileSync(path.join(out, "prompt.txt"), prompt);
const t0 = Date.now();
const r = spawnSync("claude", ["-p", "--model", process.env.CW_MODEL || "opus", "--allowedTools", "Read", "--add-dir", path.resolve(out), "--output-format", "json"], { input: prompt, encoding: "utf8", maxBuffer: 1 << 26, timeout: 300000 });
const ms = Date.now() - t0;
let res;
try { res = JSON.parse(r.stdout); } catch { console.error("claude failed", r.status, (r.stderr || "").slice(0, 400), (r.stdout || "").slice(0, 400)); process.exit(1); }
const answer = { question, now: fmt(now), window: `${fmt(from)}-${fmt(now)}`, frames: frames.map((f) => f.file), segments: segs.length, ms, cost_usd: res.total_cost_usd, model: process.env.CW_MODEL || "opus", answer: res.result };
fs.writeFileSync(path.join(out, `answer-${Date.now()}.json`), JSON.stringify(answer, null, 2));
console.log(JSON.stringify({ ...answer, answer: undefined }));
console.log("\n" + res.result);
