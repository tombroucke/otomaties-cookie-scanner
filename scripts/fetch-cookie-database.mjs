// Downloads the Open Cookie Database (Apache-2.0) into data/. The data is not committed to git;
// it is fetched on install/build and shipped in the npm package.
// To update: change COMMIT to a newer commit of jkwakman/Open-Cookie-Database and run with --force.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

const COMMIT = '81813835edc9682113a4d95989358da5256d30c1';
const BASE = `https://raw.githubusercontent.com/jkwakman/Open-Cookie-Database/${COMMIT}`;
const FILES = {
    'open-cookie-database.csv': 'open-cookie-database.csv',
    'OPEN-COOKIE-DATABASE-LICENSE': 'LICENSE',
};

const dir = new URL('../data/', import.meta.url);
const force = process.argv.includes('--force');
mkdirSync(dir, { recursive: true });

for (const [target, source] of Object.entries(FILES)) {
    const path = new URL(target, dir);
    if (existsSync(path) && !force) {
        continue;
    }
    const response = await fetch(`${BASE}/${source}`);
    if (!response.ok) {
        console.error(`Failed to download ${source}: ${response.status}`);
        process.exit(1);
    }
    writeFileSync(path, await response.text());
    console.log(`Downloaded data/${target}`);
}
