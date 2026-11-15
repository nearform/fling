// The CloudFront Function (cloudfront-js-2.0, viewer-response) on the sites distribution's /api/*
// behaviour, attached only when the instance runs site servers. It puts a site server's own 403 or
// 404 back: the Web Function entry sends those as SERVER_STAND_IN_STATUS with SERVER_STATUS_HEADER
// naming the real status, so the distribution's custom error responses (403 and 404 become the
// sites' error page) never take them, and a viewer-response function runs only below 400
// (@fling/shared/route-keys says why the stand-in is 300).
//
// It only rewrites: the header comes off any answer that has it, and the status changes only on a
// stand-in naming a status it stands in for. An answer without the header (a server's own 300, a
// file from the bucket) goes out untouched.
//
// edge/build.mjs bundles this into dist/server-status.js, which deploy.yml publishes. Same syntax
// rules as site-routing.ts.

import { restoredServerStatus, SERVER_STATUS_HEADER } from '@fling/shared/route-keys'

const REASONS = { 403: 'Forbidden', 404: 'Not Found' }

function handler(event) {
  const response = event.response
  const sent = response.headers[SERVER_STATUS_HEADER]
  if (!sent) return response
  delete response.headers[SERVER_STATUS_HEADER]
  const status = restoredServerStatus(response.statusCode, sent.value)
  if (status !== response.statusCode) {
    response.statusCode = status
    response.statusDescription = REASONS[status]
  }
  return response
}

// Stripped by build.mjs: CloudFront calls the top-level `handler`.
export { handler }
