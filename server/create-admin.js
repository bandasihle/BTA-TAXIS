// Creates an admin account from the command line, on the machine that holds the database:
//   npm run create-admin -- --name "Sipho Banda" --phone 0821234567
// A temporary PIN is printed once; the admin must choose their own when they first sign in.
import { parseArgs } from 'node:util';
import { openDb, DEFAULT_DB } from './db.js';
import { createAuth } from './auth.js';

const { values } = parseArgs({ options: { name: { type: 'string' }, phone: { type: 'string' } } });
if (!values.name || !values.phone) {
  console.error('Usage: npm run create-admin -- --name "Full Name" --phone 0821234567');
  process.exit(1);
}

const auth = createAuth(openDb(process.env.DB_FILE || DEFAULT_DB));
try {
  const { user, pin } = await auth.createUser({ name: values.name, phone: values.phone, role: 'admin' });
  console.log(`Admin created: ${user.name}, ${user.phone}`);
  console.log(`Temporary PIN: ${pin}`);
  console.log('Give it to them privately. They must choose their own PIN when they sign in.');
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
