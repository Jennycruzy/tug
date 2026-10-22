# Pre-record measurements (22 Oct 2026)

The raw data (Strike copy discovery, Hyperliquid fills for 15–22 Oct, the first net map) is kept in the
`tug-evidence` repository under `pre-record/` because of its size (12 MB compressed). Its hashes are
listed in `MANIFEST.sha256` here and there. Recompute the figures with:

    python3 -I stats_7d.py <path to tug-evidence>/pre-record
