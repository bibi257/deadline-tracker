// 画面のファイルを web/ にそろえる（Worker の静的配信用）。
// GitHub Pages がリポジトリのルートから配信している間は、ルートが元で web/ は写し。
// Pages をやめたら、ファイルを web/ に移してこのスクリプトを不要にする
import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = `${root}web/`;
const files = ['index.html', 'app.js', 'styles.css', 'service-worker.js', 'manifest.webmanifest'];

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const f of files) await cp(`${root}${f}`, `${out}${f}`);
await cp(`${root}assets`, `${out}assets`, { recursive: true });
console.log(`web/ に ${files.length} ファイルと assets/ をそろえました`);
