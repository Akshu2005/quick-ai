import 'dotenv/config';
import sql from './configs/db.js';

async function test() {
  try {
    const result = await sql`SELECT 1 as ok`;
    console.log('DB query result:', result);
    process.exit(0);
  } catch (err) {
    console.error('DB connection error:', err);
    process.exit(1);
  }
}

test();
