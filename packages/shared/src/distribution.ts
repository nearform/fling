// Where Fling itself is published: the npm package of the CLI (apps/cli/package.json `name`, kept
// in step by a test) and the GitHub repository, which is also the Claude Code plugin marketplace.
// The one place code names either; everything else imports these.

export const CLI_PACKAGE = '@nearform/fling'
export const REPO_SLUG = 'nearform/fling'

/** The command an instance's metadata advertises unless it configures its own. */
export const DEFAULT_INSTALL_COMMAND = `npm install -g ${CLI_PACKAGE}`
