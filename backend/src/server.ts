import { app, log } from './app';
const s = app.listen(3000, () => log.info('api listening on :3000'));
process.on('SIGTERM', () => { s.close(); setTimeout(() => process.exit(0), 3000); });
