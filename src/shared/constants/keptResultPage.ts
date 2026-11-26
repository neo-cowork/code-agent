/**
 * In-memory HTML snapshot of a kept result page, in UTF-16 code units
 * (`String.length`). A page over this cap is not stored.
 * 1 MiB of characters: a static Reopen copy, not an archive.
 */
export const KEPT_RESULT_PAGE_SNAPSHOT_MAX_CHARS = 1024 * 1024;
