# Transfer Safety

## Copy

1. Attempt direct source->destination transfer.
2. On failure, download to local staging then upload to destination.
3. Verify destination using strict policy.

## Move

1. Run copy flow.
2. Only if verification passes, delete source.
3. If verification or deletion fails, mark item failed and keep source.

## Strict verification

- Compare file counts and sizes.
- If common hashes are available, compare checksums.
- If hashes are unavailable, compare modtime with a small tolerance.
