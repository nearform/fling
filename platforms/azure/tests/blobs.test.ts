/**
 * Why AzureBlobs uploads through the host (src/blobs/blob.ts): a SAS signs its URL and no request
 * header, so Put Blob through a write SAS takes a body without the Content-MD5 it was meant to
 * carry, and any Content-Type. Against Azurite, where FLING_TEST_AZURITE_ENDPOINT is set; the
 * service documents the same (the SAS string-to-sign has no request headers).
 */
import { createHash } from 'node:crypto'
import { BlobSASPermissions, generateBlobSASQueryParameters } from '@azure/storage-blob'
import { describe, expect, it } from 'vitest'
import { AZURITE_ENDPOINT, azuriteContainer } from './services.ts'

describe.runIf(AZURITE_ENDPOINT)('a write SAS on Azurite', () => {
  it('checks a Content-MD5 that is sent, and takes a body without one or with any type', async () => {
    const { container, credential } = await azuriteContainer()
    const blob = container.getBlockBlobClient('up/index.html')
    const sas = generateBlobSASQueryParameters(
      {
        containerName: container.containerName,
        blobName: 'up/index.html',
        permissions: BlobSASPermissions.parse('cw'),
        expiresOn: new Date(Date.now() + 60_000),
        contentType: 'text/html',
      },
      credential
    )
    const url = `${blob.url}?${sas}`
    const body = '<!doctype html><title>hi</title>'
    const md5 = createHash('md5').update(body).digest('base64')
    const put = (headers: Record<string, string>, content = body) =>
      fetch(url, {
        method: 'PUT',
        headers: { 'x-ms-blob-type': 'BlockBlob', ...headers },
        body: content,
      })

    expect((await put({ 'content-md5': md5 }, 'something else')).status).toBe(400)
    expect((await put({ 'content-md5': md5, 'x-ms-blob-content-type': 'text/html' })).status).toBe(
      201
    )
    expect((await put({}, 'something else')).status).toBe(201)
    expect((await put({ 'x-ms-blob-content-type': 'application/javascript' })).status).toBe(201)
  })
})
