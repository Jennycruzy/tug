# Pre-record measurements (22 Oct 2026)

The raw data (Strike copy discovery, Hyperliquid fills for 15–22 Oct, the first net map) is kept in the
`tug-evidence` repository under `pre-record/` because of its size (12 MB compressed). Its hashes are
listed in `MANIFEST.sha256` here and there. Recompute the figures with:

    python3 -I stats_7d.py <path to tug-evidence>/pre-record

On 23 Oct, before the data was made public, the Strike account ids in `discover_all.json.gz` and `lt.json` were
replaced by codes (TUG never lists Strike traders one by one). The figures are unchanged. The 22 Oct SHA-256 of
both files and the new ones are in `pre-record/REDACTION.md` in the `tug-evidence` repository.
