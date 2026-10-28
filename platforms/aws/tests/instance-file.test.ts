import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseInstanceConfig } from '../scripts/instance-config.mjs'
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

describe('FLING_INSTANCE_CONFIG (what scripts/build.mjs writes as instance.json)', () => {
  it('takes a flat object of ENV_STYLE keys', () => {
    expect(parseInstanceConfig('{"INSTANCE_NAME":"Acme","LIVE":false}')).toEqual({
      INSTANCE_NAME: 'Acme',
      LIVE: false,
    })
    expect(() => parseInstanceConfig('{"lower":"x"}')).toThrow(/ENV_STYLE/)
    expect(() => parseInstanceConfig('{"A":{"b":1}}')).toThrow(/ENV_STYLE/)
  })

  it('refuses mail settings: email is set in the Terraform mail variable', () => {
    for (const key of ['MAIL_DRIVER', 'MAIL_FROM', 'SES_CONFIGURATION_SET']) {
      expect(() => parseInstanceConfig(JSON.stringify({ [key]: 'x' }))).toThrow(
        new RegExp(`${key} is not allowed`)
      )
    }
  })
})
