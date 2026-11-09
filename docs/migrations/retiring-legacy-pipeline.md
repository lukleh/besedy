# Retire obsolete pipeline inputs

Routine commands read the current contracts only. Existing catalogs must use
the base catalog writer's columns, including `Hash Algorithm` and `added_at`.
Duplicate and archive manifests must have their current writer's columns.
Joined manifests must use the writer's exact 31-column header, full lowercase
source and output audio hashes, and explicit positive `Source Order` and
`Source Count` values. Blank descriptive metadata and source bitrate remain
valid. The join command refuses incompatible existing manifests before
creating joined audio or moving originals, and a failed output hash never
produces a manifest row.
CSV durations use `HH:MM:SS`, normalized manifests end in
`_loudness_normalized.csv`, and transcript paths use a full audio hash and an
explicit `@lang-<code>` or `@lang-auto` component. Transcript JSON must satisfy
`docs/schemas/transcript.schema.json`; confidence may explicitly be `null`.

Recreate obsolete catalogs from their source audio with `catalog create`.
Keep metadata from old files separately until it has been reconciled with the
current catalog. Do not relabel an untyped file hash as a decoded-audio hash.
Rename unsuffixed transcript backend keys using
[the backend-key migration](renaming-a-transcript-backend-key.md). Do not merely
rename `transcript_original.json` without verifying and converting its schema.
Recordings lists must be `{"version": 1, "audio_hashes": [...]}` objects;
empty lists use that same object with an empty array.

For an old bare JSON hash array or newline-separated list, preserve the hashes
inside that versioned object and validate each as a full lowercase audio hash.
Do not translate another hash algorithm into this contract by relabeling it.
For an old `MM:SS` catalog duration, prefix the zero-hour component and pad all
components (for example `1:30` becomes `00:01:30`). Re-measure source audio when
the old value is fractional, invalid or ambiguous. These are explicit file
edits before rollout; routine readers do not convert them.

For an old joined manifest with missing hashes or ordering, recover those
values only from the recorded source/output audio and verified join provenance.
Do not substitute paths, filenames, or row positions for missing identities.
If that provenance cannot be recovered, preserve the file separately with
the explicit retirement procedure below before creating a new manifest.
No automatic converter guesses how historical joined rows correspond.

Incomplete loudness rows are automatically measured again. This rebuilds a
derived cache under the current contract; it does not retain an alternate
format reader.

## Explicit retirement tool

The tool defaults to a dry-run and prints only the planned operations:

```sh
uv run python -m scripts.retire_legacy_pipeline --config /absolute/path/besedy.toml
uv run python -m scripts.retire_legacy_pipeline --sidecars-root /absolute/path/original-audio
```

The first operation removes the retired `[web].deep_search_default_instructions`
assignment while preserving other TOML content. Remove it from both the host
configuration and any separately rendered container configuration before the
new code starts. Add `--apply` only after reviewing each plan.

The sidecar operation invalidates `.audiohash` cache files without the current
algorithm and source-integrity markers. It never changes source audio or
pretends to know an old hash's algorithm. The next normal ingest computes a
fresh canonical hash. It does not follow directory symlinks.

To retire standalone historical CSVs, first collect every live DB/config path
reference, map container paths to host paths, and save the absolute host paths
as a JSON array. List concrete artifact files and active artifact subtrees,
such as the configured transcript generation. Exclude broad storage roots
such as `text_data_dir` or `AUDIO_DIR`: those contain both live and obsolete
artifacts and would prevent retirement of every contained file. Run during
maintenance so references cannot change during the move.

```sh
uv run python -m scripts.retire_legacy_pipeline \
  --retire-file /absolute/path/catalogs/audio_catalog_merged_v2.csv \
  --references-json /absolute/path/active-paths.json \
  --retired-dir /absolute/path/retired-pipeline-files
```

The tool refuses referenced files, directories, source symlinks, destination
collisions (including dangling symlinks), and retirement without the reference
snapshot. Only explicitly named regular files move;
repeat `--retire-file` for each reviewed file. The destination must be outside
the live data trees; the tool also refuses a destination overlapping an active
artifact reference. Review the dry-run, then repeat with `--apply`. Preserve
the retired files until their useful metadata has been reconciled; remove
them afterward according to the normal backup policy.

## Production inventory checked on 8 November 2026

The active `20251222_144441` generation already has current catalog headers,
256 complete loudness rows, full hash leaves and language-suffixed ASR model
directories. No `transcript_original.json` files were found. The four standalone
`curated`, `metadata`, `merged` and `merged_v2` CSVs were outside the database's
active path references. Their complete operational reference graph still needs
review before retirement. Of 712 original-audio sidecars, 449 lacked current
markers; all active catalog sources had current markers. This inventory is
evidence for planning, not authorization to mutate production automatically.
