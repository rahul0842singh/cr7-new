import { createApplication } from './app.mjs';
try {
  const app = await createApplication();
  const port = Number(process.env.PORT || process.env.API_PORT || 3001);
  const host = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
  app.server.on('error',async()=>{console.error('Unable to start HTTP server. Check the configured host and port.');await app.close();process.exit(1);});
  app.server.listen(port,host,()=>console.log(`CR7 server (MongoDB): http://${host}:${port}`));
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await app.close();process.exit(0);});
} catch {
  // MongoDB errors may contain connection credentials; never print the URI or raw error.
  console.error('Server startup failed. Check ADMIN_PASSWORD (16+ characters), MONGODB_URI, MONGODB_DB, and MongoDB network access. See DASHBOARD.md.');
  process.exit(1);
}
