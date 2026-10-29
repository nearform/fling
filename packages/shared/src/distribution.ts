// Where Fling itself is published: the npm package of the CLI (apps/cli/package.json `name`, kept
// in step by a test) and the GitHub repository, which is also the Claude Code plugin marketplace.
// The one place code names either; everything else imports these.

export const CLI_PACKAGE = '@nearform/fling'
export const REPO_SLUG = 'nearform/fling'

/** The command an instance's metadata advertises unless it configures its own. */
export const DEFAULT_INSTALL_COMMAND = `npm install -g ${CLI_PACKAGE}`

/** The repository's page, where Fling's guides live. */
export const REPO_URL = `https://github.com/${REPO_SLUG}`

/** A guide in the repository (`path` from its root, e.g. `platforms/aws/DEPLOY.md`), on main. */
export const guideUrl = (path: string, anchor?: string) =>
  `${REPO_URL}/blob/main/${path}${anchor ? `#${anchor}` : ''}`

/**
 * The site that says what Fling is for: the page in `why/`, which an admin publishes
 * on their instance, public, after setup. Get started links to it once it is live.
 */
export const WHY_SITE_NAME = 'why-fling'
