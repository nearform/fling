/**
 * Conformance suites for the API's ports, and for Records (the Store written over Table). An
 * adapter package calls one per adapter from a vitest test file:
 * `tableConformance('DynamoTable', () => new DynamoTable(table, client))`.
 */
export { type BlobsHarness, blobsConformance } from './blobs.ts'
export { routeTableConformance } from './route-table.ts'
export { storeConformance } from './store.ts'
export { tableConformance } from './table.ts'
