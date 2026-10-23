import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { MCP_REMOTE_INSTRUCTIONS, mcpTools } from '../src/mcp-tools.ts'

describe('mcp tool catalogue', () => {
  const tools = Object.values(mcpTools)

  it('has unique fling_ names and non-empty descriptions', () => {
    const names = tools.map(t => t.name)
    expect(new Set(names).size).toBe(names.length)
    for (const t of tools) {
      expect(t.name).toMatch(/^fling_[a-z_]+$/)
      expect(t.description.length).toBeGreaterThan(20)
    }
  })

  it('steers Claude away from sandbox paths and towards confirming names', () => {
    expect(mcpTools.publish.description).toMatch(/never pass file paths from your sandbox/)
    expect(mcpTools.publish.description).toMatch(/confirm it with them/)
    expect(MCP_REMOTE_INSTRUCTIONS).toMatch(/fling_publish/)
  })

  it('validates publish input', () => {
    const schema = z.object(mcpTools.publish.inputSchema)
    expect(
      schema.safeParse({ name: 'a', files: [{ path: 'index.html', content: 'x' }] }).success
    ).toBe(true)
    expect(schema.safeParse({ name: 'a', files: [] }).success).toBe(false)
    expect(
      schema.safeParse({
        name: 'a',
        files: [{ path: 'a', content: 'x', encoding: 'hex' }],
      }).success
    ).toBe(false)
    const del = z.object(mcpTools.delete.inputSchema)
    expect(del.safeParse({ name: 'a', confirm: false }).success).toBe(false)
  })
})
