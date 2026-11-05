/**
 * The facts the Guide quotes (`{{fact:<key>}}`), read from the constants that decide them, so a
 * limit or a name changes in the guide the moment it changes in the code. A fact the shared
 * package cannot import (the CLI's) is pinned here, and a test in apps/web compares it with the
 * real value.
 */
import { AUDIENCE_EMAILS_MAX, AUDIENCE_GROUPS_MAX } from './audience.ts'
import { COMMENT_MAX_CHARS, COMMENTS_PER_SITE_MAX, RESPONSES_PER_SITE_MAX } from './comments.ts'
import { CLI_PACKAGE, REPO_SLUG, REPO_URL, WHY_SITE_NAME } from './distribution.ts'
import { FORMS_MAX } from './forms.ts'
import { GROUP_MEMBERS_MAX } from './groups.ts'
import {
  MAX_DEPLOY_BYTES,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_PATH_FOLDER_LENGTH,
  MAX_PATHS_PER_SITE,
} from './limits.ts'
import { MAX_MARKDOWN_BYTES, MAX_RENDERED_MARKDOWN } from './markdown.ts'
import { MCP_PUBLISH_MAX_BYTES } from './mcp-tools.ts'
import { MAIL_TESTS_PER_HOUR } from './notifications.ts'
import { SITE_PASS_TTL_SECONDS } from './route-keys.ts'
import { SITE_NAME_MAX } from './site-labels.ts'
import { OWNER_EMAILS_MAX, PUBLISHER_EMAILS_MAX } from './site-roles.ts'

const mb = (bytes: number) => `${bytes / (1024 * 1024)} MB`
const count = (n: number) => n.toLocaleString('en-GB')

/**
 * Facts that live in other packages, checked against them: the CLI's by apps/web/tests/guide.test.ts,
 * the API's by apps/api/tests/guide-facts.test.ts.
 */
export const PINNED_GUIDE_FACTS = {
  /** the oldest Node the CLI runs on (apps/cli/package.json `engines.node`) */
  'node-version': '22',
  /** how long the audit log keeps an entry (`AUDIT_TTL_DAYS`) */
  'audit-days': '180 days',
  /** how long an admin's impersonation lasts (`IMPERSONATION_TTL_SECONDS`) */
  'impersonation-ttl': 'an hour',
  /** how long an invitation's sign-in link works (`INVITATION_LINK_TTL_SECONDS`) */
  'invite-link-ttl': '7 days',
  /** new outside addresses one person may invite a day, unless the instance says otherwise (`INVITES_PER_DAY`) */
  'invites-per-day': '20',
  /** how long an address that bounced or complained gets no mail (`SUPPRESSION_MS`) */
  'suppression-days': '30 days',
} as const

export const GUIDE_FACTS: Readonly<Record<string, string>> = {
  'max-deploy': mb(MAX_DEPLOY_BYTES),
  'max-file': mb(MAX_FILE_BYTES),
  'max-files': count(MAX_FILES),
  'max-inline': mb(MCP_PUBLISH_MAX_BYTES),
  'max-paths': count(MAX_PATHS_PER_SITE),
  'max-folder': count(MAX_PATH_FOLDER_LENGTH),
  'site-name-max': count(SITE_NAME_MAX),
  'mail-tests-per-hour': count(MAIL_TESTS_PER_HOUR),
  'markdown-max-size': mb(MAX_MARKDOWN_BYTES),
  'markdown-max-files': count(MAX_RENDERED_MARKDOWN),
  'access-revoke-delay': `${SITE_PASS_TTL_SECONDS / 60} minutes`,
  'audience-emails-max': count(AUDIENCE_EMAILS_MAX),
  'audience-groups-max': count(AUDIENCE_GROUPS_MAX),
  'group-members-max': count(GROUP_MEMBERS_MAX),
  'owner-emails-max': count(OWNER_EMAILS_MAX),
  'publisher-emails-max': count(PUBLISHER_EMAILS_MAX),
  'comments-max': count(COMMENTS_PER_SITE_MAX),
  'comment-max-chars': count(COMMENT_MAX_CHARS),
  'forms-max': count(FORMS_MAX),
  'responses-max': count(RESPONSES_PER_SITE_MAX),
  'cli-package': CLI_PACKAGE,
  'repo-slug': REPO_SLUG,
  'repo-url': REPO_URL,
  'why-site': WHY_SITE_NAME,
  ...PINNED_GUIDE_FACTS,
}
