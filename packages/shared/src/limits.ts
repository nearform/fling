export const MAX_DEPLOY_BYTES = 100 * 1024 * 1024
export const MAX_FILE_BYTES = 25 * 1024 * 1024
export const MAX_FILES = 5000
export const MAX_PATH_LENGTH = 1024
/**
 * A path publish copies every file outside its path forward into the new version, one copy per
 * file in the request that makes it live. Capped so that request stays well inside a Worker's
 * subrequest budget (an R2 copy is a read and a write) and a Lambda's timeout.
 */
export const MAX_KEPT_FILES = 1000
