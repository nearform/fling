/**
 * Conformance suites for the API's ports. An adapter package calls one per adapter from a vitest
 * test file: `storeConformance('DynamoStore', () => new DynamoStore(table, client))`.
 */
export { type BlobsHarness, blobsConformance } from './blobs.ts'
export { routeTableConformance } from './route-table.ts'
export { storeConformance } from './store.ts'
