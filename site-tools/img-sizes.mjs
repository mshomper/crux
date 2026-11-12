// Prints the pixel size and file size of every PNG in site/img.
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'site', 'img');
let total = 0;
for (const name of (await readdir(dir)).filter(n => n.endsWith('.png')).sort()) {
  const b = await readFile(join(dir, name));
  total += b.length;
  console.log(`${name.padEnd(24)} ${b.readUInt32BE(16)} x ${b.readUInt32BE(20)}   ${Math.round(b.length / 1024)} KB`);
}
console.log(`total ${Math.round(total / 1024)} KB`);
