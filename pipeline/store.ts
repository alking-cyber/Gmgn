/**
 * Append-only JSONL storage plus a small state file so a restart (pm2, VPS
 * reboot) resumes tracking and journaling instead of starting over.
 *
 *   data/events.jsonl        one line per stage decision
 *   data/journal/<addr>.jsonl one snapshot per journal tick for each alerted token
 *   data/state.json          in-flight tracking / journaling state
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class Store {
  readonly journalDir: string;

  constructor(readonly dir: string, private readonly clock: () => number = now) {
    this.journalDir = join(dir, "journal");
    mkdirSync(this.journalDir, { recursive: true });
  }

  event(type: string, data: Record<string, unknown>): void {
    appendFileSync(join(this.dir, "events.jsonl"), JSON.stringify({ t: this.clock(), type, ...data }) + "\n");
  }

  journal(address: string, snap: Record<string, unknown>): void {
    if (!/^[A-Za-z0-9]{20,64}$/.test(address)) throw new Error(`refusing to journal odd address: ${address}`);
    appendFileSync(join(this.journalDir, `${address}.jsonl`), JSON.stringify(snap) + "\n");
  }

  loadState<T>(fallback: T): T {
    const p = join(this.dir, "state.json");
    if (!existsSync(p)) return fallback;
    try {
      return { ...fallback, ...JSON.parse(readFileSync(p, "utf8")) };
    } catch {
      return fallback;
    }
  }

  saveState(state: unknown): void {
    const p = join(this.dir, "state.json");
    writeFileSync(p + ".tmp", JSON.stringify(state));
    renameSync(p + ".tmp", p); // atomic, so a crash mid-write never corrupts state
  }
}

export function readJsonl<T = Record<string, unknown>>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as T];
      } catch {
        return []; // a torn last line after a crash
      }
    });
}

export const now = () => Math.floor(Date.now() / 1000);
