import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { cfg } from './config';

export const redis = new Redis({ host: cfg.redisHost, port: cfg.redisPort });
export const bull = { host: cfg.redisHost, port: cfg.redisPort };
export const issueQueue = new Queue('issue', { connection: bull });
export const maintQueue = new Queue('maint', { connection: bull });

// jobId = certificate id => enqueueing twice never creates two jobs.
export const enqueueIssue = (ids: string[]) =>
  issueQueue.addBulk(ids.map(id => ({
    name: 'issue', data: { certId: id },
    opts: { jobId: id, attempts: 10, backoff: { type: 'exponential', delay: 300 }, removeOnComplete: true, removeOnFail: true },
  })));

// Realtime fan-out: every API instance subscribes to this channel and pushes to its SSE clients.
export const publish = (type: string, data: any = {}) => redis.publish('events', JSON.stringify({ type, ...data })).catch(() => {});
