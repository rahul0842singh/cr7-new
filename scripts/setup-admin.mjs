import { existsSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
if (existsSync('.env.server')) {
  const settings=readFileSync('.env.server','utf8');
  if(!/^MONGODB_URI=/m.test(settings))appendFileSync('.env.server','\nMONGODB_URI=\n');
  if(!/^MONGODB_DB=/m.test(settings))appendFileSync('.env.server','\nMONGODB_DB=cr7\n');
  console.log('Existing password and connection settings preserved. Configure MONGODB_URI in .env.server.');
} else {
  writeFileSync('.env.server',`ADMIN_PASSWORD=${randomBytes(24).toString('base64url')}\nMONGODB_URI=\nMONGODB_DB=cr7\nAPI_PORT=3001\nHOST=127.0.0.1\nTRUSTED_PROXY_IPS=\n`,{mode:0o600});
  console.log('Admin password created in .env.server. Add your Atlas MONGODB_URI there. Never publish or commit this file.');
}
