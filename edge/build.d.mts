export declare const SITE_ROUTER_DIST: string
export declare const SITE_ROUTER_READABLE_DIST: string
/** The most the deployable function may weigh, in bytes (CloudFront takes 10 KB). */
export declare const SITE_ROUTER_MAX_BYTES: number
/** The CloudFront Function as bundled, before minifying (placeholders still in). */
export declare function buildReadableSiteRouter(): string
/** The deployable CloudFront Function source, minified (placeholders still in). */
export declare function buildSiteRouter(): string
export declare const SERVER_STATUS_DIST: string
export declare const SERVER_STATUS_READABLE_DIST: string
/** The most any CloudFront Function this builds may weigh, in bytes. */
export declare const EDGE_FUNCTION_MAX_BYTES: number
/** The server status function as bundled, before minifying. */
export declare function buildReadableServerStatus(): string
/** The deployable server status function, minified. */
export declare function buildServerStatus(): string
