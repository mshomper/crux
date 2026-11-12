// Downloads the page's two font families from their official GitHub repositories (tagged releases) into
// site/fonts, with their licence files. Both are under the SIL Open Font Licence. Run once; the files are committed.
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'site', 'fonts');
const FILES = [
  ['https://github.com/rsms/inter/raw/v4.1/docs/font-files/InterVariable.woff2', 'InterVariable.woff2'],
  ['https://github.com/rsms/inter/raw/v4.1/LICENSE.txt', 'Inter-LICENSE.txt'],
  ['https://github.com/JetBrains/JetBrainsMono/raw/v2.304/fonts/webfonts/JetBrainsMono-Medium.woff2', 'JetBrainsMono-Medium.woff2'],
  ['https://github.com/JetBrains/JetBrainsMono/raw/v2.304/fonts/webfonts/JetBrainsMono-SemiBold.woff2', 'JetBrainsMono-SemiBold.woff2'],
  ['https://github.com/JetBrains/JetBrainsMono/raw/v2.304/OFL.txt', 'JetBrainsMono-OFL.txt']
];
await mkdir(out, { recursive: true });
for (const [url, name] of FILES) {
  const res = await fetch(url, { headers: { 'user-agent': 'font-fetch' } });
  if (!res.ok) { console.error(`${name}: ${res.status} ${url}`); process.exitCode = 1; continue; }
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(join(out, name), buf);
  console.log(`${name}  ${buf.length} bytes  ${name.endsWith('.woff2') ? 'magic ' + buf.subarray(0, 4).toString('latin1') : ''}`);
}
