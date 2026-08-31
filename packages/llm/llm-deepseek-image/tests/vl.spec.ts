/**
 * Unit tests for the vision-language backend selection and fact resolution.
 * Network-free: these cover `vlBackendOf` and `resolveVlConfig` only.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_BAILIAN_BASE_URL,
  DEFAULT_BAILIAN_MODEL,
  DEFAULT_DEEPSEEK_VL_MODEL,
  DEFAULT_PROMPT,
  resolveVlConfig,
  vlBackendOf,
} from '../src/vl.ts'

// Point homedir at a path that never exists so readQwenConfig() returns {} —
// the Bailian fallback tests stay deterministic on any machine, including one
// with a real ~/.qwen-mm-plugins/config.
vi.mock('node:os', async (importOriginal) => {
  const os = await importOriginal<typeof import('node:os')>()
  return { ...os, homedir: () => '/tmp/dsh-vl-spec-nonexistent-home' }
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('vlBackendOf', () => {
  it('defaults to the DeepSeek backend', () => {
    expect(vlBackendOf({})).toBe('deepseek')
  })

  it('honors an explicit backend', () => {
    expect(vlBackendOf({ vlBackend: 'bailian' })).toBe('bailian')
    expect(vlBackendOf({ vlBackend: 'deepseek' })).toBe('deepseek')
  })
})

describe('resolveVlConfig', () => {
  it('resolves the DeepSeek backend with the route base URL and the DeepSeek key', () => {
    const vl = resolveVlConfig({}, 'ds-key', 'https://api.deepseek.com')
    expect(vl.backend).toBe('deepseek')
    expect(vl.baseURL).toBe('https://api.deepseek.com')
    expect(vl.apiKey).toBe('ds-key')
    expect(vl.model).toBe(DEFAULT_DEEPSEEK_VL_MODEL)
    expect(vl.prompt).toBe(DEFAULT_PROMPT)
  })

  it('lets explicit model and base URL override the DeepSeek backend', () => {
    const vl = resolveVlConfig(
      { vlModel: 'deepseek-custom-vision', vlBaseURL: 'https://proxy.example.com' },
      'ds-key',
      'https://api.deepseek.com',
    )
    expect(vl.backend).toBe('deepseek')
    expect(vl.baseURL).toBe('https://proxy.example.com')
    expect(vl.model).toBe('deepseek-custom-vision')
  })

  it('resolves the Bailian backend with its defaults when nothing else names them', () => {
    vi.stubEnv('DASHSCOPE_BASE_URL', undefined)
    vi.stubEnv('QWEN_MM_API_VL_MODEL', undefined)
    const vl = resolveVlConfig({ vlBackend: 'bailian' }, 'bailian-key', '')
    expect(vl.backend).toBe('bailian')
    expect(vl.baseURL).toBe(DEFAULT_BAILIAN_BASE_URL)
    expect(vl.apiKey).toBe('bailian-key')
    expect(vl.model).toBe(DEFAULT_BAILIAN_MODEL)
  })

  it('lets explicit config override the Bailian backend', () => {
    const vl = resolveVlConfig(
      { vlBackend: 'bailian', vlModel: 'qwen-custom', vlBaseURL: 'https://bailian.example.com/v1' },
      'bailian-key',
      '',
    )
    expect(vl.backend).toBe('bailian')
    expect(vl.baseURL).toBe('https://bailian.example.com/v1')
    expect(vl.model).toBe('qwen-custom')
    expect(vl.apiKey).toBe('bailian-key')
  })
})
