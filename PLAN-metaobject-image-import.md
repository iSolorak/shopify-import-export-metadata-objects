# Plan — import images from a website into metaobject `file_reference` fields

Target page: **Import & export** (`app/routes/app._index/route.tsx`), entries import only.
Scope of change agreed: metaobject entries; `write_files`; reuse existing files by filename.

---

## The problem

`planEntryImport` treats every cell as an opaque string and `upsertEntry` posts it
through verbatim. That is deliberate — it is what makes the export/import round trip
lossless — but it means a `file_reference` field only accepts the exact thing the
export produced:

| Field type             | What the export writes                    |
| ---------------------- | ----------------------------------------- |
| `file_reference`       | `gid://shopify/MediaImage/123`            |
| `list.file_reference`  | `["gid://shopify/MediaImage/123","gid://…"]` |

A merchant filling the sheet by hand has a website URL, not a gid, and there is no
way to get one without leaving the app, uploading to Content → Files by hand, and
copying the id back. This closes that loop.

## The approach

A cell on a file-typed field is **resolved to a gid before the diff is taken**:

- already a gid, or a JSON array of gids → passed through untouched (round trip
  stays lossless, exactly as today);
- otherwise split on `;` (the separator the metaobject-reference columns already
  use), each part must be an `https:` URL;
- each URL is matched against a file already in the store **by filename**; a hit
  reuses that gid;
- a miss is uploaded with `fileCreate` and the returned gid is used.

`fileCreate` accepts an external URL directly in `originalSource` for images, so
none of `remote-video.ts`'s staged-upload machinery is needed here — no download
through the VPS, no size cap, no `Content-Length` requirement. Shopify pulls the
bytes itself.

Both operations were validated against the 2026-07 schema this app pins.

## The subtlety that shapes the design

`planEntryImport` decides `unchanged` by comparing the cell to the stored value. A
stored `gid://…` will never equal a cell holding `https://…`, so **every row with an
image URL would look changed on every run** — re-importing an unedited file would
rewrite the whole set and churn `updatedAt`, which is precisely what the existing
`unchanged` detection exists to prevent.

So resolution has to happen **before** the diff, not during the write. That is also
what makes the plan step honest: the review table can say "3 images to upload,
2 already in Files" while still having written nothing.

This mirrors the pattern the product importer already uses — `PlanContext` carries
a resolved `metaobjects` map and an injected `toMetafieldValue`, gathered up front
because the planner is pure and cannot await. The same shape is reused here rather
than inventing a second one.

Consequence: the **filename lookup runs at plan time** (read-only, safe), and only
the `fileCreate` calls are deferred to apply. A URL already in Files therefore
resolves during planning and correctly reports `unchanged`.

## Files touched

### New — `app/lib/files.server.ts`

House conventions: structural `Admin` type, private `query` that throws on transport
and `errors[]`, `#graphql` documents, mutations returning `userErrors` rather than
throwing.

- `uploadFilenameFor(handle, url)` — `<handle>-<hash8><ext>`, e.g.
  `dermatologically-tested-edee03b6.jpg`, where `hash8` is the first 8 hex chars
  of SHA-256 over the **full source URL** and `ext` comes from the URL's last path
  segment (falling back to the served `Content-Type` when the URL has none).

  The hash is what makes the dedupe key correct rather than merely tidy. Filename
  is the reuse key, so a name derived from the handle alone would find the *old*
  file when a handle is later pointed at a different image, and the new image
  would silently never import. Including a hash of the URL means a changed URL is
  a changed filename is a new upload. The handle prefix is what keeps
  Content → Files readable; source filenames in the wild are often content
  hashes (as they are in the acceptance file below) and carry nothing a merchant
  can search for.

  Generalised from `remote-video.ts`'s `filenameFor`, which hardcodes a `.mp4`
  fallback and keeps the source name verbatim.
- `findFilesByFilename(admin, filenames)` → `Map<filename, gid>`. Batched
  `files(query: "filename:…")`, several terms OR'd per call, quotes escaped the way
  `getProductsForUpdateByTitle` escapes titles. Results filtered to an **exact**
  filename match afterwards — the file search is fuzzy, and reusing the wrong image
  is silent damage of exactly the kind this app exists to avoid.
- `createFilesFromUrls(admin, [{url, filename, alt}])` → `Map<url, gid>`.
  `contentType: IMAGE`, `duplicateResolutionMode: APPEND_UUID` (we have already
  deduped by lookup, so this is the non-destructive fallback for a genuine
  filename collision). Batched well under the 250-per-call cap — 25, matching the
  house batch sizes.

  `FileCreateInput` confirmed against 2026-07: `originalSource` (required),
  `contentType`, `alt`, `filename` (optional — falls back to the name in
  `originalSource`), `duplicateResolutionMode` (defaults to `APPEND_UUID`).

**Alt text** comes from the row's `display_name` column, falling back to the
handle. `display_name` is on every entries CSV this app exports and is ignored on
import today, so it costs nothing to read and it is the only human-readable label
the row carries. An image landing in Files with no alt is unsearchable and
inaccessible, which is a poor default when a good one is sitting in the file.

### New — file-cell parsing (pure)

Either `app/lib/file-cells.ts` or a section of `metaobject-csv.ts`.

- `FILE_TYPES = ["file_reference", "list.file_reference"]`
- `isResolvedFileValue(cell)` — bare gid, or JSON array of gids.
- `fileUrlsIn(cell)` — split on `;`, trim, drop blanks.
- `toFileValue(cell, resolved)` — gid for a single field, `JSON.stringify(ids)` for
  a list field. Returns `{ok:false, message}` rather than throwing, so one bad cell
  becomes one error row next to the fields that did import — same contract as
  `toMetafieldValue`.

Error cases: a non-https URL; more than one URL on a non-list `file_reference`; a
URL whose upload failed.

### Changed — `app/lib/metaobject-csv.ts`

`planEntryImport` gains a context argument carrying the resolved
`Map<url, gid>` and the definition's field types, and resolves file cells before
diffing. `RowPlan` gains the resolved `values` (what will actually be written) so
the apply step does not re-derive them, plus the review table can show the upload.

`ImportPlan` gains a counts summary for the file work:
`{ reused: number, toUpload: number }` and the distinct URLs pending upload.

### Changed — `app/routes/app._index/route.tsx`

- Both `plan` and `apply` gather the distinct URLs from file-typed columns, derive
  filenames, and call `findFilesByFilename` before planning.
- `apply` additionally calls `createFilesFromUrls` for the misses, merges the two
  maps, then re-plans and upserts. Uploads happen **before** the upsert loop so a
  row never half-writes.
- Cap distinct new uploads per run — **100** — in the spirit of `MAX_ROWS`. Each is
  a network round trip inside a request nginx gives 300 seconds.
- Review section gains a line: *"N image(s) will be uploaded to Files, M already
  there."* Failures list per-row URL errors as they do today.
- Copy on the import section explains the new accepted format.

### Changed — `shopify.app.toml`

Add `write_files` to `scopes`, with a comment in the established style noting what
uses it and that it re-prompts merchants for consent on next load — matching the
existing note on the inventory scopes.

## Order of work

1. `files.server.ts` + the pure cell parsing, with the two validated documents.
2. Wire resolution into `planEntryImport` behind the new context argument.
3. Route: plan-time lookup, apply-time upload, review copy.
4. `shopify.app.toml` scope.
5. `npm run typecheck` and `npm run lint`.

## Acceptance case

`~/Downloads/Radiant_Export/claim-entries-2026-09-09.csv` — an export of the
`claim` metaobject with a `name` and an `image` field, five rows:

```
handle,display_name,name,image
dermatologically-tested,Dermatologically tested,…,https://radiant-professional.com/media/cache/ed/ee/edee03b6a730824ecf4311a3d6d072e0.jpg
paraben-free,Paraben-free,…,gid://shopify/MediaImage/62399654035799
… three more, all gids
```

`image` is a **single** `file_reference` — the resolved cells are bare gids with
no brackets, which is what distinguishes it from `list.file_reference`. The source
URL was probed: HTTP 200, `image/jpeg`, 2822 bytes, public https, so `fileCreate`
can pull it directly. The file carries a UTF-8 BOM and LF endings; `parseCsv`
already handles both.

Expected behaviour on this file:

1. Plan step reports **1 image to upload**, 4 cells passed through untouched, and
   the four gid rows as `unchanged` (assuming nothing else differs).
2. Apply uploads one file as `dermatologically-tested-<hash8>.jpg` with alt
   `Dermatologically tested`, then upserts `dermatologically-tested` with the
   returned gid.
3. **Re-running the identical file writes nothing** — the filename lookup finds
   the uploaded file, resolves the URL to the same gid, and all five rows report
   `unchanged`. This is the property most worth testing, because getting it wrong
   means a duplicate upload on every run.

## Open items to confirm at runtime

- **`filename:` search syntax.** The `files` connection takes a `query` argument and
  the query itself validates, but the docs pages I searched do not spell out the
  supported search prefixes. If `filename:` is not honoured the exact-match filter
  still makes the result correct — it just degrades to scanning, so this needs one
  real call against the dev store to confirm before the batching is tuned. There is
  a fallback: page `files` once per import and build the filename map client-side.
- **Async processing.** `fileCreate` returns the gid immediately with
  `fileStatus: UPLOADED`; the image becomes `READY` seconds later. The metaobject
  reference holds either way, but the admin may show a placeholder briefly right
  after an import reports success. Worth a sentence in the finished-import banner.
- **Extension-less URLs.** `uploadFilenameFor` takes the extension from the URL
  path. A URL that has none needs the served `Content-Type` instead, which means a
  `HEAD` at plan time for those rows only — the common case stays lookup-only.
