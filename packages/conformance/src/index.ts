/**
 * Conformance suites for the API's ports (Mailer included), and for Records (the Store written over Table). An
 * adapter package calls one per adapter from a vitest test file:
 * `tableConformance('DynamoTable', () => new DynamoTable(table, client))`.
 */
export { type BlobsHarness, blobsConformance } from './blobs.ts'
export {
  type DeliveredMail,
  EXPECTED_FAILURE,
  type MailerConformanceOptions,
  type MailerHarness,
  mailerConformance,
  message as mailMessage,
  PROVIDER_FAILURES,
  type ProviderFailure,
} from './mailer.ts'
export { legacyItems, migrationsConformance } from './migrations.ts'
export { routeTableConformance } from './route-table.ts'
export { storeConformance } from './store.ts'
export { tableConformance } from './table.ts'
