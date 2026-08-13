# vaultsite

Point it at an Obsidian vault; it builds a website.

    npx vaultsite build MyVault --out public
    npx vaultsite build MyVault --out public --watch
    npx vaultsite new my-project --title "My Project"

No configuration file. Every word on the page comes from the vault, and what the
vault contains is the vault's own business — the section notes in its `pages/`
folder say which folders are collections, where they land on the site, and how
each one is drawn.

New to it? **[docs/starting-a-new-site.md](docs/starting-a-new-site.md)** is the
walkthrough, and the pitfalls. What follows is the reference.

## What a vault says about itself

`pages/Site.md` carries the chrome: title, subtitle, description, `domain:`, the
footer. Everything else in `pages/` is a section:

```yaml
type: section
section: field-notes          # the collection's name
source: 01 Field notes        # the folder its notes live in
dir: field-notes              # where they land on the site
label: Field note             # the singular, for kickers and feed categories
view: entries                 # how the section is drawn
order: 20                     # where it stands on the landing page
limit: 3                      # how many the landing page shows
archive: true                 # and a page holding the full run
archive_label: All the field notes
heading: Field notes
apparatus: Dated, newest first
```

Drop `source:` and the section is just words. Drop `order:` and it falls to the
end. Add `landing: false` and it builds its archive without standing on the
landing page. Add `publish: false` and it goes away.

## Views

A view is how a collection is drawn. Any view can be pointed at any folder.

| view | what it draws |
|---|---|
| `entries` | a dated list: when, the title, a line about it |
| `cards` | whole notes, one under another, for short ones worth reading in place |
| `strands` | grouped into columns by a field, with a mark showing where each has got to |
| `takes` | one thing, returned to on dates |
| `drawings` | the canvases |
| `movements` | prose, each `## heading` its own block |
| `prose` | just the words |

Collections drawn as `entries`, `cards` or `takes` are sequences, so each note
carries the two either side of it. `sequence: false` opts out.

## What the engine knows without being told

Obsidian, and nothing about any particular project. A page per note; wikilinks
including `[[Note#Heading]]` and `[[Note#^block]]`; backlinks; tags with a page
each and an index; a graph of the whole vault; callouts, highlights, comments,
footnotes, transclusion; mathematics rendered to MathML at build time; Mermaid
diagrams, shipped only to the pages that have one; canvases at `/maps` with a
note beside each carrying its metadata; bases; an RSS feed carrying full text;
older/newer links; sitemap, robots.txt and a 404.

`[[Tags]]`, `[[Graph]]`, `[[Maps]]` and `[[Feed]]` resolve in any vault, and stay
plain text until there is something behind them.

## Canvases

A canvas is private until it says otherwise. It publishes only when a note of the
same name sits beside it saying `publish: true` — a canvas is somewhere to think,
and thinking in public should be a decision. That note also carries `title:`,
`slug:`, `date:`, `summary:` and `tags:`, and its body renders above the drawing.

## The look

The engine ships structure and a plain default: near-white paper, dark ink, a
grey accent, a serif that exists everywhere, and no masthead. It is meant to be
readable and to belong to nobody.

A project sets its own in `pages/Site.md`, and these become a `:root` block that
overrides the default:

    masthead: terrain      the generated ink landform; `plain` is the default
    paper:   '#f2ede1'     and paper_2, paper_3 for the shades under it
    ink:     '#1b1917'     and ink_2, grey, grey_2
    accent:  '#b42718'     the seal, hover, the alarming callouts
    font_serif: "…"        and font_mono, font_cjk
    measure: 34rem         how wide a line of prose runs
    canvas_colours: ['#…'] Obsidian's six card colours, in its own order

Anything past those goes in `theme/theme.css`, which loads after the engine's
stylesheet, so it overrides selectively rather than replacing 400 lines you would
then have to maintain.

`theme/` also stands in for any engine asset of the same name: `theme/og.png` for
the social card, `theme/favicon.ico`, `theme/apple-touch-icon.png`,
`theme/terrain.js` for a different landform, `theme/site.css` if you really want
to start again.

## Hosting

Anything that runs a build command and serves a folder. On Cloudflare Pages:
build command `npm run build`, output directory `public`, Node from `.nvmrc`.

`vaultsite new` writes a `package.json`, a `.gitignore`, a `.nvmrc` and a
`DEPLOY.md` alongside the vault, so a new project is deployable as it stands.

## Requirements

Node 20 or later. No dependencies — `marked` and `katex` are vendored, and
`mermaid` is vendored for the browser and copied out only when a page has a
diagram on it.
