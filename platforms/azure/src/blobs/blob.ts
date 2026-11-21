/**
 * AzureBlobs: the Blobs port on one Azure Blob Storage container (`sites`).
 *
 * Uploads: a SAS signs only its URL (the permissions, the blob, the times), never a request
 * header, so a SAS PUT can't be bound to a body: Put Blob checks a `Content-MD5` the client sends
 * but takes a body without one, and any Content-Type (tests/blobs.test.ts shows both on Azurite).
 * So `presignPut` signs the host's upload route (HostUploads, @fling/api/blobs/host-uploads): the
 * host checks the SHA-256 itself and writes the bytes with `put`. Every upload passes through the
 * Container App and its request-size limit (32 MiB, above MAX_FILE_BYTES); `uploadDigest` is the
 * port's default, `sha256`, so publication needs no staging copy.
 *
 * Downloads: `presignGet` is a read-only SAS for one blob, good for `expiresIn` seconds. With a
 * token credential (the host's managed identity) it is a user delegation SAS, signed with a key
 * the service hands the identity (Storage Blob Data Contributor allows it) and kept for an hour;
 * with an account key (Azurite) it is a service SAS.
 *
 * `copy` is a server-side Copy Blob within the account, which keeps Content-Type and
 * Cache-Control; `deletePrefix` lists the prefix a page at a time and deletes what it lists.
 */

import {
  BlobSASPermissions,
  type BlobServiceClient,
  type ContainerClient,
  generateBlobSASQueryParameters,
  StorageSharedKeyCredential,
  type UserDelegationKey,
} from '@azure/storage-blob'
import type { Blobs, PresignedPut, PresignPutOptions } from '@fling/api/blobs'

const isNotFound = (err: unknown) => (err as { statusCode?: number } | null)?.statusCode === 404

/** How long a user delegation key is used for; the service allows up to 7 days. */
const DELEGATION_KEY_MS = 60 * 60 * 1000
/** A delegation key is renewed once it has less than this left (the longest presigned GET). */
const DELEGATION_KEY_MARGIN_MS = 15 * 60 * 1000

/** How many deletes of a listing page run at once. */
const DELETE_CONCURRENCY = 32

export interface AzureBlobsOptions {
  /** where `presignPut` sends uploads: the core's HostUploads on the platform's host */
  uploads: Pick<Blobs, 'presignPut'>
  now?: () => number
}

export class AzureBlobs implements Blobs {
  private delegation?: { key: UserDelegationKey; until: number }

  constructor(
    private service: BlobServiceClient,
    private container: ContainerClient,
    private opts: AzureBlobsOptions
  ) {}

  private now() {
    return (this.opts.now ?? Date.now)()
  }

  private blob(key: string) {
    return this.container.getBlockBlobClient(key)
  }

  presignPut(key: string, opts: PresignPutOptions): Promise<PresignedPut> {
    return this.opts.uploads.presignPut(key, opts)
  }

  async presignGet(key: string, opts: { expiresIn?: number } = {}): Promise<string> {
    const blob = this.blob(key)
    const values = {
      containerName: this.container.containerName,
      blobName: key,
      permissions: BlobSASPermissions.parse('r'),
      expiresOn: new Date(this.now() + (opts.expiresIn ?? 900) * 1000),
    }
    const credential = this.service.credential
    const sas =
      credential instanceof StorageSharedKeyCredential
        ? generateBlobSASQueryParameters(values, credential)
        : generateBlobSASQueryParameters(
            values,
            await this.delegationKey(),
            this.service.accountName
          )
    return `${blob.url}?${sas.toString()}`
  }

  /** A user delegation key with time to spare, from the service when the last one runs low. */
  private async delegationKey(): Promise<UserDelegationKey> {
    const now = this.now()
    if (this.delegation && this.delegation.until - DELEGATION_KEY_MARGIN_MS > now) {
      return this.delegation.key
    }
    // Starts a little in the past, so a clock behind the service's still signs valid URLs.
    const until = now + DELEGATION_KEY_MS
    const key = await this.service.getUserDelegationKey(new Date(now - 5 * 60_000), new Date(until))
    this.delegation = { key, until }
    return key
  }

  async head(key: string) {
    try {
      const props = await this.blob(key).getProperties()
      return { size: props.contentLength ?? 0 }
    } catch (err) {
      if (isNotFound(err)) return null
      throw err
    }
  }

  async put(
    key: string,
    body: Uint8Array,
    opts: { contentType?: string; cacheControl?: string } = {}
  ) {
    await this.blob(key).uploadData(body, {
      blobHTTPHeaders: {
        ...(opts.contentType ? { blobContentType: opts.contentType } : {}),
        ...(opts.cacheControl ? { blobCacheControl: opts.cacheControl } : {}),
      },
    })
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await this.blob(key).downloadToBuffer())
    } catch (err) {
      if (isNotFound(err)) return null
      throw err
    }
  }

  async putJson(key: string, value: unknown) {
    await this.put(key, new TextEncoder().encode(JSON.stringify(value)), {
      contentType: 'application/json',
    })
  }

  async getJson<T>(key: string): Promise<T | null> {
    const body = await this.get(key)
    return body ? (JSON.parse(new TextDecoder().decode(body)) as T) : null
  }

  /** Copy Blob within the account: authorised by this client's credential, metadata kept. */
  async copy(from: string, to: string) {
    const poller = await this.blob(to).beginCopyFromURL(this.blob(from).url)
    const result = await poller.pollUntilDone()
    if (result.copyStatus && result.copyStatus !== 'success') {
      throw new Error(`Copy of ${from} ended ${result.copyStatus}`)
    }
  }

  async delete(key: string) {
    await this.blob(key).deleteIfExists()
  }

  async deletePrefix(prefix: string) {
    if (!prefix.endsWith('/')) throw new Error('deletePrefix needs a `dir/` prefix')
    for await (const page of this.container
      .listBlobsFlat({ prefix })
      .byPage({ maxPageSize: 1000 })) {
      const names = page.segment.blobItems.map(b => b.name)
      for (let i = 0; i < names.length; i += DELETE_CONCURRENCY) {
        await Promise.all(
          names.slice(i, i + DELETE_CONCURRENCY).map(n => this.blob(n).deleteIfExists())
        )
      }
    }
  }
}
