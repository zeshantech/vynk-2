// Small JSON state file in the data volume (EOD reviews, processed message ids).

import fs from "node:fs/promises";
import path from "node:path";

export class Store {
  constructor(dataDir) {
    this.file = path.join(dataDir, "state.json");
    this.data = { processed: {}, reviews: {}, waiting: {} };
    this.writing = Promise.resolve();
  }

  async load() {
    try {
      this.data = { ...this.data, ...JSON.parse(await fs.readFile(this.file, "utf8")) };
    } catch (err) {
      if (err.code !== "ENOENT") console.warn(`Could not read ${this.file}: ${err.message}`);
    }
    this.prune();
  }

  prune() {
    const now = Date.now();
    const weekAgo = now - 7 * 24 * 3600 * 1000;
    for (const [k, v] of Object.entries(this.data.processed)) if (v < weekAgo) delete this.data.processed[k];
    for (const [k, v] of Object.entries(this.data.reviews)) if (v.createdAt < weekAgo) delete this.data.reviews[k];
    for (const [k, v] of Object.entries(this.data.waiting)) if (v.createdAt < weekAgo) delete this.data.waiting[k];
  }

  save() {
    this.prune();
    const snapshot = JSON.stringify(this.data);
    this.writing = this.writing.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(`${this.file}.tmp`, snapshot, { mode: 0o600 });
      await fs.rename(`${this.file}.tmp`, this.file);
    });
    return this.writing;
  }

  /** True the first time a key is seen (Slack retries and edits deliver the same message again). */
  async firstTime(key) {
    if (this.data.processed[key]) return false;
    this.data.processed[key] = Date.now();
    await this.save();
    return true;
  }
}
