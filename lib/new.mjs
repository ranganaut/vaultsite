/* A vault to start from: the folders, the section notes that describe them,
   and the two files a host needs. Everything here is meant to be edited. */
import fs from 'node:fs';
import path from 'node:path';

const put = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) return false;
  fs.writeFileSync(file, text);
  return true;
};

export function scaffold({ dir, title }) {
  const root = path.resolve(dir);
  const name = path.basename(root);
  const vault = path.join(root, name);
  if (fs.existsSync(vault) && fs.readdirSync(vault).length)
    throw new Error(`${vault} already has something in it`);

  const made = [];
  const add = (f, t) => { if (put(path.join(root, f), t)) made.push(f); };

  add(`${name}/pages/Site.md`, `---
type: site
title: ${title}
subtitle: One line about it.
description: A sentence for search engines and social cards.
domain:
back_label: Back to ${title}
---
## Footer

What this is, in a sentence or two.

## Footer aside

Other ways in: [[Tags]] · [[Graph]] · [[Maps]] · [[Feed]]
`);

  add(`${name}/pages/Opening.md`, `---
type: section
section: opening
view: movements
order: 10
---
The first thing a reader meets. Write it here; every \`## heading\` below
becomes its own block on the page.
`);

  add(`${name}/pages/Notes.md`, `---
type: section
section: notes
source: 01 Notes
dir: notes
label: Note
view: entries
order: 20
limit: 3
archive: true
archive_path: notes
archive_label: All the notes
heading: Notes
apparatus: Dated, newest first
---
What this collection is for.
`);

  add(`${name}/pages/Maps.md`, `---
type: section
section: maps
view: drawings
order: 30
limit: 2
archive: true
archive_path: maps
archive_label: All the maps
heading: Maps
apparatus: Drawn, not written
empty_label: nothing drawn yet
---
Canvases from the vault.
`);

  add(`${name}/01 Notes/.keep`, '');
  add(`${name}/Maps/.keep`, '');
  add(`${name}/99 Assets/.keep`, '');
  add(`${name}/00 Meta/README.md`,
    `Nothing in 00 Meta reaches the site. Working notes go here.\n`);

  add('package.json', JSON.stringify({
    name, private: true, type: 'module',
    scripts: { build: `vaultsite build ${name} --out public`,
               watch: `vaultsite build ${name} --out public --watch` },
    dependencies: { vaultsite: 'github:ranganaut/vaultsite' },
  }, null, 2) + '\n');
  add('.gitignore', 'public/\nnode_modules/\n.DS_Store\n');
  add('.nvmrc', '22\n');
  add('DEPLOY.md', `# Deploying ${title}

Cloudflare Pages, or any host that runs a build command and serves a folder.

    Build command:      npm run build
    Output directory:   public
    Node version:       read from .nvmrc

Set \`domain:\` in \`${name}/pages/Site.md\` once the domain exists. Until then the
sitemap, the social cards and the feed are simply not written, which is what you
want while working locally. Claim the domain in the Pages project *before*
pointing DNS at it.
`);

  console.log(`${title} — a vault to start from, at ${root}`);
  for (const f of made) console.log(`  · ${f}`);
  console.log(`\n  npm install && npm run build`);
}
