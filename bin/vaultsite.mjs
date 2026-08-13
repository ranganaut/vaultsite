#!/usr/bin/env node
/* vaultsite — point it at an Obsidian vault and it builds a site.
 *
 *   vaultsite build [vault] [--out public] [--watch]
 *   vaultsite new <folder> [--title "The Name"]
 */
import path from 'node:path';
import { build, watch } from '../lib/build.mjs';
import { scaffold } from '../lib/new.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const bare = argv.filter((a, i) =>
  !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') &&
    ['out', 'title', 'vault'].includes(argv[i - 1].slice(2))));

const cmd = bare[0] || 'build';
const where = bare[1] || flag('vault', '.');

try {
  if (cmd === 'build') {
    const opts = { vault: where, out: flag('out', 'public') };
    build(opts);
    if (argv.includes('--watch')) watch(opts);
  } else if (cmd === 'new') {
    if (!bare[1]) throw new Error('vaultsite new <folder> — say where the vault should go');
    scaffold({ dir: bare[1], title: flag('title', path.basename(path.resolve(bare[1]))) });
  } else {
    console.log(`vaultsite build [vault] [--out public] [--watch]
vaultsite new <folder> [--title "The Name"]`);
    process.exit(cmd === 'help' || argv.includes('--help') ? 0 : 1);
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
