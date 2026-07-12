import fs from 'node:fs';
import postgres from 'postgres';
const sql = postgres('postgresql://hotelos:hotelos@localhost:5432/hotelos_ci');
for (const f of ['../infra/postgres/init/01-extensions.sql', '../infra/postgres/init/02-app-role.sql']) {
  await sql.unsafe(fs.readFileSync(f, 'utf8'));
  console.log('applied', f);
}
await sql.end();
