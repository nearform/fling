export const MAX_DEPLOY_BYTES = 100 * 1024 * 1024
export const MAX_FILE_BYTES = 25 * 1024 * 1024
export const MAX_FILES = 5000
/**
 * A site file's path, in bytes of UTF-8 (a character is one to four). Every key made from a path
 * (a Table sk like `FILE#<path>`, an object key like `sites/<id>/<v>/.rendered/<path>.html`) stays
 * well under the stores' limits: DynamoDB's 1,024-byte sort key, S3's 1,024-byte object key, and
 * the 1,500 bytes of a value Firestore indexes.
 */
export const MAX_PATH_BYTES = 900
/**
 * The longest path a stored file may already have, in characters: files deployed while the cap
 * counted characters keep serving, and a partial publish's `remove` can still name them.
 */
export const MAX_STORED_PATH_LENGTH = 1024
/**
 * A publish on a base (after a pull) copies the base's files it keeps forward into the new
 * version, one copy per file in the request that makes it live. Capped so that request stays well
 * inside a Worker's subrequest budget (an R2 copy is a read and a write) and a Lambda's timeout.
 */
export const MAX_KEPT_FILES = 1000
/** A Path's folder (paths.ts in the API): one segment, at most this long. */
export const MAX_PATH_FOLDER_LENGTH = 100
/**
 * How many Paths a site may have in all, live or archived; also the most live Paths an instance
 * may allow a site (`PATHS_PER_SITE_MAX`, published as `limits.pathsPerSite`), and its default.
 */
export const MAX_PATHS_PER_SITE = 1000
