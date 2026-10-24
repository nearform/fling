import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { instanceFileEnv } from '../src/lambda.ts'

const file = (content: string) => {
  const path = join(mkdtempSync(join(tmpdir(), 'fling-instance-')), 'instance.json')
  writeFileSync(path, content)
  return pathToFileURL(path)
}

describe('instance.json (the instance values a deploy ships in lambda.zip)', () => {
  it('reads a flat object as env strings; no file is no values', () => {
    expect(
      instanceFileEnv(file('{"ALLOWED_EMAIL_DOMAINS":"example.test","INSTANCE_NAME":"Acme"}'))
    ).toEqual({ ALLOWED_EMAIL_DOMAINS: 'example.test', INSTANCE_NAME: 'Acme' })
    expect(instanceFileEnv(new URL('file:///nonexistent/instance.json'))).toEqual({})
  })

  it('refuses anything but an object', () => {
    expect(() => instanceFileEnv(file('["x"]'))).toThrow(/JSON object/)
    expect(() => instanceFileEnv(file('nope'))).toThrow()
  })
})
