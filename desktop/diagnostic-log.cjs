'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { clean } = require('../public/diagnostics.js');

const logName = /^diagnostic-\d{13}-[a-f0-9-]{36}-\d+\.jsonl$/;
const safeVersion = value => typeof value === 'string' && /^\d{1,5}(?:\.\d{1,8}){1,4}$/.test(value) ? value : undefined;

class DiagnosticLog {
    constructor(directory, version, { maxBytes = 256 * 1024, maxFiles = 8, days = 7 } = {}) {
        this.directory = directory;
        this.version = safeVersion(version);
        this.maxBytes = maxBytes;
        this.maxFiles = maxFiles;
        this.maxAge = days * 86400_000;
        this.run = randomUUID();
        this.active = null;
        this.bytes = 0;
        this.segment = 0;
        this.queue = Promise.resolve();
        this.queued = 0;
        this.recent = new Map();
    }

    write(record) {
        const event = clean(record);
        if (!event || this.queued >= 100) return Promise.resolve();
        const key = JSON.stringify(event);
        const now = Date.now();
        if (this.recent.has(key) && now - this.recent.get(key) < 1500) return Promise.resolve();
        this.recent.set(key, now);
        if (this.recent.size > 128) this.recent.delete(this.recent.keys().next().value);
        const row = JSON.stringify({ at: new Date(now).toISOString(), version: this.version, run: this.run, ...event }) + '\n';
        const size = Buffer.byteLength(row);
        this.queued++;
        const job = this.queue.then(async () => {
            if (!this.active || this.bytes + size > this.maxBytes || now - this.openedAt > 86400_000) {
                await fs.mkdir(this.directory, { recursive: true });
                const file = path.join(this.directory, `diagnostic-${now}-${this.run}-${++this.segment}.jsonl`);
                await fs.writeFile(file, row, { flag: 'wx' });
                this.active = file;
                this.openedAt = now;
                this.bytes = size;
                await this.prune(now);
            } else {
                await fs.appendFile(this.active, row);
                this.bytes += size;
            }
        }).finally(() => { this.queued--; });
        this.queue = job.catch(() => {});
        return job;
    }

    async list() {
        const entries = await fs.readdir(this.directory, { withFileTypes: true }).catch(error => {
            if (error.code === 'ENOENT') return [];
            throw error;
        });
        return entries.filter(entry => entry.isFile() && logName.test(entry.name)).map(entry => entry.name).sort().reverse();
    }

    async prune(now) {
        const files = await this.list();
        await Promise.all(files.filter((file, index) => index >= this.maxFiles || now - Number(file.slice(11, 24)) > this.maxAge)
            .map(file => fs.unlink(path.join(this.directory, file)).catch(() => {})));
    }

    async report(environment) {
        await this.queue;
        const now = Date.now();
        const records = [];
        const files = (await this.list()).slice(0, this.maxFiles).reverse();
        for (const file of files) {
            if (now - Number(file.slice(11, 24)) > this.maxAge) continue;
            const absolute = path.join(this.directory, file);
            const stat = await fs.lstat(absolute).catch(() => null);
            if (!stat?.isFile() || stat.size > this.maxBytes + 1024) continue;
            const body = await fs.readFile(absolute, 'utf8').catch(() => '');
            for (const line of body.split('\n')) {
                try {
                    const row = JSON.parse(line);
                    const event = clean(row);
                    const at = typeof row?.at === 'string' && row.at.length <= 32 ? Date.parse(row.at) : NaN;
                    if (event && Number.isFinite(at) && Math.abs(now - at) <= this.maxAge && /^[a-f0-9-]{36}$/.test(row.run || '')) {
                        records.push({ at: new Date(at).toISOString(), version: safeVersion(row.version), run: row.run, ...event });
                    }
                } catch { /* An interrupted write may leave a partial line. */ }
            }
        }
        return { schema: 1, app: 'Friends Screen Share', version: this.version, exportedAt: new Date(now).toISOString(),
            environment: { windows: safeVersion(environment.windows), electron: safeVersion(environment.electron), chrome: safeVersion(environment.chrome) },
            records: records.slice(-2000) };
    }
}

module.exports = { DiagnosticLog };
