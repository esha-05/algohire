export const cfg = {
  pg: process.env.DATABASE_URL || 'postgres://certi:certi@localhost:5432/certi',
  redisHost: process.env.REDIS_HOST || 'localhost',
  redisPort: Number(process.env.REDIS_PORT || 6379),
  jwt: process.env.JWT_SECRET || 'dev-secret',
  wa: process.env.WA_URL || 'http://localhost:4010',
  storage: process.env.STORAGE_DIR || './data/certs',
  publicUrl: process.env.PUBLIC_URL || 'http://localhost:8080',
  qualityThreshold: Number(process.env.QUALITY_THRESHOLD || 50),   // batches this big get quality-team review
  slaSeconds: Number(process.env.SLA_SECONDS || 172800),            // 48h in one review stage => escalate
  demoLogin: process.env.DEMO_LOGIN !== '0',
  testHooks: process.env.ENABLE_TEST_HOOKS === '1',
};
if (process.env.NODE_ENV === 'production' && cfg.jwt === 'dev-secret') throw new Error('Set JWT_SECRET');
