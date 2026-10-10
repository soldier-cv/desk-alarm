/** tsc 只搬 .ts，schema.pg.sql 得自己复制到 dist */
import { copyFileSync, mkdirSync } from 'node:fs';

const pairs = [['src/schema.pg.sql', 'dist/server/src/schema.pg.sql']];

for (const [from, to] of pairs) {
  mkdirSync(to.replace(/[^/\\]+$/, ''), { recursive: true });
  copyFileSync(from, to);
  console.log(`copied ${from} -> ${to}`);
}
