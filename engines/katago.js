import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const COLS = "ABCDEFGHJKLMNOPQRSTUVWXYZ";

const DEBUG_ENABLED = process.env.GO_TUTOR_DEBUG === "1";
const DEBUG_DIR = process.env.GO_TUTOR_DEBUG_DIR || path.resolve("debug_logs");
const DEBUG_LOG_PATH = path.join(DEBUG_DIR,`katago-${new Date().toISOString().replaceAll(":","-").replaceAll(".","-")}.jsonl`);
if (DEBUG_ENABLED) fs.mkdirSync(DEBUG_DIR,{recursive:true});
function debugLog(event,data=null) {
  if (!DEBUG_ENABLED) return;
  try { fs.appendFileSync(DEBUG_LOG_PATH,JSON.stringify({timestamp:new Date().toISOString(),event,data})+"\
"); } catch {}
}

export function gtpToPoint(move, size = 19) {
  const s = String(move).trim().toUpperCase();
  if (s === "PASS") return {type:"pass", move:"pass"};
  if (s === "RESIGN") return {type:"resign", move:"resign"};
  const m = s.match(/^([A-Z])(\d+)$/);
  if (!m) throw new Error(`Unrecognized KataGo move: ${move}`);
  const x = COLS.indexOf(m[1]);
  const y = size - Number(m[2]);
  if (x < 0 || x >= size || y < 0 || y >= size)
    throw new Error(`Out-of-range KataGo move: ${move}`);
  return {type:"move", move:s, x, y};
}

export class KataGoGtp {
  constructor({executablePath="katago", modelPath="", configPath=""}) {
    this.executablePath = executablePath || "katago";
    this.modelPath = modelPath;
    this.configPath = configPath;
    this.process = null;
    this.buffer = "";
    this.pending = [];
    this.stderrTail = "";
  }

  get key() {
    return JSON.stringify({
      executablePath:this.executablePath,
      modelPath:this.modelPath,
      configPath:this.configPath
    });
  }

  async start() {
    if (this.process && !this.process.killed) return;
    if (!this.modelPath) throw new Error("KataGo model path is not configured.");
    if (!this.configPath) throw new Error("KataGo GTP config path is not configured.");
    if (!fs.existsSync(this.modelPath)) throw new Error(`KataGo model not found: ${this.modelPath}`);
    if (!fs.existsSync(this.configPath)) throw new Error(`KataGo config not found: ${this.configPath}`);

    this.process = spawn(
      this.executablePath,
      ["gtp","-model",this.modelPath,"-config",this.configPath],
      {stdio:["pipe","pipe","pipe"]}
    );

    this.process.stdout.on("data", data => {
      this.buffer += data.toString().replaceAll("\r\n","\n");
      this.#drain();
    });

    this.process.stderr.on("data", data => {
      const text = data.toString();
      this.stderrTail = (this.stderrTail + text).slice(-8000);
      process.stderr.write(`[katago] ${text}`);
    });

    this.process.on("error", err => {
      this.#rejectAll(new Error(`Could not launch KataGo: ${err.message}`));
      this.process = null;
    });

    this.process.on("exit", code => {
      if (this.pending.length)
        this.#rejectAll(new Error(`KataGo exited with code ${code}. ${this.stderrTail}`));
      this.process = null;
    });

    await this.send("name", 120000);
  }

  #rejectAll(err) {
    for (const p of this.pending.splice(0)) {
      clearTimeout(p.timer);
      p.reject(err);
    }
  }

  #drain() {
    while (true) {
      const i = this.buffer.indexOf("\n\n");
      if (i < 0) return;
      const raw = this.buffer.slice(0,i).trim();
      this.buffer = this.buffer.slice(i+2);
      if (!raw) continue;
      if (raw[0] !== "=" && raw[0] !== "?") continue;

      const req = this.pending.shift();
      if (!req) continue;
      clearTimeout(req.timer);

      const payload = raw.slice(1).trim().replace(/^\d+\s*/,"");
      debugLog("gtp-response",{success:raw[0] === "=",payload});
      if (raw[0] === "=") req.resolve(payload);
      else req.reject(new Error(payload || "KataGo rejected a command."));
    }
  }

  async send(command, timeoutMs=120000) {
    debugLog("gtp-command",{command});
    if (!this.process || this.process.killed) {
      if (command !== "name") await this.start();
    }
    if (!this.process?.stdin) throw new Error("KataGo process is unavailable.");

    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => {
        const idx = this.pending.findIndex(p => p.resolve === resolve);
        if (idx >= 0) this.pending.splice(idx,1);
        reject(new Error(`KataGo timed out: ${command}`));
      }, timeoutMs);
      this.pending.push({resolve,reject,timer});
      this.process.stdin.write(`${command}\n`);
    });
  }

  async test() {
    await this.start();
    return {
      name: await this.send("name"),
      version: await this.send("version")
    };
  }

  async syncPosition({boardSize=19, komi=6.5, history=[]}) {
    await this.start();
    await this.send(`boardsize ${boardSize}`);
    await this.send(`komi ${komi}`);
    await this.send("clear_board");
    for (const item of history)
      await this.send(`play ${String(item.color).toUpperCase()} ${String(item.move).toUpperCase()}`);
  }

  async genMove({boardSize=19, komi=6.5, history=[], color}) {
    await this.syncPosition({boardSize,komi,history});
    const raw = await this.send(`genmove ${String(color).toUpperCase()}`,180000);
    return gtpToPoint(raw,boardSize);
  }

  stop() {
    if (!this.process) return;
    try { this.process.stdin.write("quit\n"); } catch {}
    const p = this.process;
    setTimeout(() => {
      if (p && !p.killed) p.kill();
    },500);
  }
}
