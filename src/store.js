// Pluggable persistence for the engine state + the public dashboard JSON.
//
//   FileStore  — local dev: state.json on disk, outputs under public/data/
//   S3Store    — AWS deploy: state under s3://bucket/state/, outputs under
//                s3://bucket/data/ (served as the static site's data feed)
//
// Selected by environment: set S3_BUCKET to use S3, otherwise files are used.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createState } from './engine.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const OUTPUT_FILES = {
  config: 'config.json',
  status: 'status.json',
  current: 'current.json',
  timeseries: 'timeseries.json',
  accuracy: 'accuracy.json',
  home: 'home.json',
  storms: 'storms.json',
};

class FileStore {
  constructor(statePath, publicDir = PUBLIC_DIR) {
    this.statePath = statePath;
    this.dataDir = join(publicDir, 'data');
  }
  async load() {
    if (!existsSync(this.statePath)) return createState();
    try {
      return JSON.parse(readFileSync(this.statePath, 'utf8'));
    } catch {
      return createState();
    }
  }
  async save(state) {
    mkdirSync(dirname(this.statePath), { recursive: true });
    writeFileSync(this.statePath, JSON.stringify(state));
  }
  async writeOutputs(outputs) {
    mkdirSync(this.dataDir, { recursive: true });
    for (const [key, file] of Object.entries(OUTPUT_FILES)) {
      writeFileSync(join(this.dataDir, file), JSON.stringify(outputs[key]));
    }
  }
}

class S3Store {
  // dataBucket: the public site bucket (holds data/*.json served to browsers).
  // stateBucket: a private bucket for the running state (defaults to dataBucket).
  constructor({ dataBucket, stateBucket, region, statePrefix = 'state', dataPrefix = 'data' }) {
    this.dataBucket = dataBucket;
    this.stateBucket = stateBucket || dataBucket;
    this.region = region;
    this.stateKey = `${statePrefix}/state.json`;
    this.dataPrefix = dataPrefix;
    this._client = null;
  }
  async client() {
    if (this._client) return this._client;
    const { S3Client } = await import('@aws-sdk/client-s3');
    this._client = new S3Client(this.region ? { region: this.region } : {});
    return this._client;
  }
  async load() {
    const c = await this.client();
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    try {
      const res = await c.send(
        new GetObjectCommand({ Bucket: this.stateBucket, Key: this.stateKey })
      );
      const body = await res.Body.transformToString();
      return JSON.parse(body);
    } catch (err) {
      if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) {
        return createState();
      }
      throw err;
    }
  }
  async save(state) {
    const c = await this.client();
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    await c.send(
      new PutObjectCommand({
        Bucket: this.stateBucket,
        Key: this.stateKey,
        Body: JSON.stringify(state),
        ContentType: 'application/json',
        CacheControl: 'no-store',
      })
    );
  }
  async writeOutputs(outputs) {
    const c = await this.client();
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    await Promise.all(
      Object.entries(OUTPUT_FILES).map(([key, file]) =>
        c.send(
          new PutObjectCommand({
            Bucket: this.dataBucket,
            Key: `${this.dataPrefix}/${file}`,
            Body: JSON.stringify(outputs[key]),
            ContentType: 'application/json',
            // Short cache so the dashboard refreshes but the CDN still helps.
            CacheControl: 'public, max-age=60',
          })
        )
      )
    );
  }
}

export function makeStore() {
  if (process.env.S3_BUCKET) {
    return new S3Store({
      dataBucket: process.env.S3_BUCKET,
      stateBucket: process.env.S3_STATE_BUCKET,
      region: process.env.AWS_REGION,
      statePrefix: process.env.S3_STATE_PREFIX || 'state',
      dataPrefix: process.env.S3_DATA_PREFIX || 'data',
    });
  }
  const statePath =
    process.env.STATE_PATH ||
    join(__dirname, '..', 'data', 'state.json');
  return new FileStore(statePath);
}

export { FileStore, S3Store };
