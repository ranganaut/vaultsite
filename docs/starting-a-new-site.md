# Starting a new site

The README is the reference — the schema, the views, what the engine renders.
This is the walkthrough, and the things that go wrong.

## 1. Make the project

    npx vaultsite new my-project --title "My Project"

That writes a vault skeleton and the four files a host needs around it:

    my-project/
      my-project/        the vault — this is what Obsidian opens
      package.json
      .gitignore
      .nvmrc
      DEPLOY.md

**Keep the vault in a subfolder.** It is tempting to put it at the repo root and
save a level, but then `node_modules/` and `public/` sit inside the vault, and
Obsidian indexes them. The engine refuses to walk into `node_modules`, `public`,
`dist` and `build` as a safety net, but the layout is the real answer.

## 2. Say what the vault holds

One note in `pages/` per collection. The folder it reads, where it lands, what to
call one of them, and how the list is drawn:

```yaml
type: section
section: notes
source: 01 Notes
dir: notes
label: Note
view: entries
order: 20
limit: 3
archive: true
archive_label: All the notes
heading: Notes
apparatus: Dated, newest first
```

Drop `source:` and the section is just words. Drop `order:` and it falls to the
end. `landing: false` builds a section's archive without standing it on the
landing page. `publish: false` removes it.

Pick views from the table in the README. `entries` — a dated list with a line
about each — is the workhorse and covers most collections.

## 3. Pin the engine, carefully

In `package.json`, depend on a **commit, as a tarball**:

```json
"vaultsite": "https://github.com/ranganaut/vaultsite/archive/<commit>.tar.gz"
```

Not `github:ranganaut/vaultsite`, and not `git+https://…`. On a machine with
GitHub SSH keys, npm silently rewrites a git URL to `git+ssh://git@github.com/…`
and writes *that* into `package-lock.json`. It installs fine locally and then the
build host, which has no key, fails on a repo that is public. A tarball takes git
out of it: plain HTTPS, no credentials, nothing to rewrite. npm also records a
checksum, so a changed tarball is caught rather than built.

A commit rather than a branch means a push to the engine can never change what a
live site builds without someone deciding it should. To move to a newer engine,
change the hash, delete `package-lock.json`, install, look at the result, commit
both files.

Check `node_modules/` is in `.gitignore` before the first install, or several
megabytes of engine land in the repo.

## 4. Write, and build

    npm install
    npm run build      # or: npm run watch

Then open `public/index.html`.

**Read the build log.** It is the diagnostic. It names every link that went
nowhere, every link to a note that exists but does not publish, every drawing held
back and which of the three reasons applied, every note left out of the feed for
want of a date, and every canvas whose companion note matches no drawing. Most
questions of the form "why isn't this showing up" are answered there.

## 5. Deploy

Anything that runs a build command and serves a folder. On Cloudflare Pages:

    Build command:      npm run build
    Output directory:   public
    Node version:       from .nvmrc

Set `domain:` in `pages/Site.md` once the domain exists. Until then the sitemap,
the social cards and the feed are simply not written, which is what you want
while working locally. **Claim the domain in the Pages project before pointing
DNS at it**, or it answers 522.

## Things that surprise people

**Obsidian rewrites your frontmatter.** A `tags: [a, b]` typed by hand becomes a
list down the page the moment the property panel touches the file. The engine
reads both, but do not be alarmed when a file changes shape on its own.

**A canvas is private until it says otherwise.** It publishes only when a note of
the same name sits beside it saying `publish: true`. That note carries the
drawing's title, date, summary and tags too, and its body renders above the
drawing. The names must match exactly, in the same folder — rename one and not
the other and the build says so rather than failing quietly.

**A note with nothing in it has no page.** It still appears in its list; it is
simply not a link. `status: planned` does the same for something announced before
it is written.

**Links keep their words.** A `[[link]]` to a note that does not exist, or exists
but does not publish, renders as plain text rather than breaking the page. The
build log says which.

**Only what is used is shipped.** The Mermaid renderer is 3.5 MB and reaches only
the pages that have a diagram. The canvas script only goes to pages that draw one.
The landform script only exists if the vault asked for a landform.

## Making it look like yours

The engine's default is plain on purpose. Set the palette, the fonts and the
masthead in `pages/Site.md`; put anything beyond that in `theme/theme.css`, which
loads after the engine's stylesheet so you override what you want and inherit the
rest. `theme/` also stands in for any engine asset of the same name — the social
card, the icons, the landform. Field names are in the README.

Resist the urge to fork `site.css`. Four hundred lines of it are structure you
would then have to maintain; the mood is a dozen values.
