/**
 * Vision-language bridge: describe an image through an OpenAI-compatible
 * chat-completions endpoint and return the model's text description. Two
 * backends are supported: `deepseek` (DeepSeek's own vision model, the
 * default) and `bailian` (DashScope compatible-mode, the original default).
 * For the Bailian backend, the endpoint and model resolve from explicit plugin
 * config, then the process environment, then `~/.qwen-mm-plugins/config` — the
 * same source the qwen-mm-plugins MCP server reads — then defaults. The API
 * key itself is resolved by the registering plugin (credentials seam) and
 * passed in.
 * @module dsh-llm-deepseek-image/vl
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LlmError } from '@deepseek-ai/dsh-llm'

/** The two vision-language backends the bridge can describe images through. */
export type VlBackend = 'deepseek' | 'bailian'

/** Default backend: DeepSeek's own vision model, so one DEEPSEEK_API_KEY covers chat + images. */
export const DEFAULT_VL_BACKEND: VlBackend = 'deepseek'

/** DeepSeek vision-language model (experimental), billed like V4-Flash. */
export const DEFAULT_DEEPSEEK_VL_MODEL = 'deepseek-v4-flash-vision-exp'

/** Public OpenAI-compatible DashScope endpoint, used for the Bailian backend when nothing else names one. */
export const DEFAULT_BAILIAN_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'

/** Default Bailian vision-language model, matching the qwen-mm-plugins VL default. */
export const DEFAULT_BAILIAN_MODEL = 'qwen3.7-plus'

/** Default description prompt: full scene + verbatim text transcription. */
export const DEFAULT_PROMPT = 'Describe this image in complete detail so that a person who cannot see it can fully understand it. Include: (1) the main subjects, objects, and scene; (2) ALL visible text transcribed verbatim; (3) colors, layout, and any other important visual details. Be thorough but concise.'

/** Resolved vision-language facts for one request. */
export interface VlConfig {
  /** Which backend these facts describe. */
  backend: VlBackend
  /** OpenAI-compatible base URL; `/chat/completions` is appended. */
  baseURL: string
  /** Bearer token for the endpoint. */
  apiKey: string
  /** Model id accepted by the endpoint. */
  model: string
  /** Prompt paired with each image. */
  prompt: string
}

/** Optional plugin config fields that name the VL backend, endpoint, and model (not the key). */
export interface VlConfigInput {
  /** Vision backend; defaults to DeepSeek's own vision model (`deepseek`). */
  vlBackend?: VlBackend
  vlBaseURL?: string
  vlModel?: string
  vlPrompt?: string
}

/** The active backend for a config snapshot, defaulting to DeepSeek's own vision model. */
export function vlBackendOf(input: VlConfigInput): VlBackend {
  return input.vlBackend ?? DEFAULT_VL_BACKEND
}

/** Parse a minimal `KEY=VALUE` dotenv file; empty on any read/parse failure. */
export function readQwenConfig(): Record<string, string> {
  try {
    const text = readFileSync(join(homedir(), '.qwen-mm-plugins', 'config'), 'utf8')
    const out: Record<string, string> = {}
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue
      const eq = trimmed.indexOf('=')
      const key = trimmed.slice(0, eq).trim()
      let value = trimmed.slice(eq + 1).trim()
      if (value.length >= 2 && (value[0] === '"' || value[0] === '\'') && value[value.length - 1] === value[0]) {
        value = value.slice(1, -1)
      }
      if (key) out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Merge `values` into `~/.qwen-mm-plugins/config` (KEY=VALUE lines, written
 * atomically with mode 0600), preserving any lines already there. Used to
 * mirror the Bailian credential from the DSH store into the file the bundled
 * qwen-mm-plugins MCP servers (Python) read, so one Models-page entry covers
 * both the bridge and the media tools.
 */
export function writeQwenConfig(values: Record<string, string>): void {
  const file = join(homedir(), '.qwen-mm-plugins', 'config')
  const merged = readQwenConfig()
  let changed = false
  for (const [key, value] of Object.entries(values)) {
    if (merged[key] !== value) {
      merged[key] = value
      changed = true
    }
  }
  if (!changed) return
  mkdirSync(join(homedir(), '.qwen-mm-plugins'), { recursive: true })
  const body = Object.keys(merged).sort().map(key => `${key}=${merged[key]}`).join('\n')
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `# qwen-mm-plugins config — KEY=VALUE per line\n\n${body}\n`, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, file)
}

/**
 * Resolve VL facts for the active backend. `apiKey` is the already-resolved
 * bearer token for that backend (DeepSeek for `deepseek`, Bailian for
 * `bailian`); `deepseekBaseURL` supplies the DeepSeek endpoint when the
 * DeepSeek backend is active. Bailian facts keep the original precedence:
 * explicit config → environment → `~/.qwen-mm-plugins/config` → defaults.
 */
export function resolveVlConfig(input: VlConfigInput, apiKey: string, deepseekBaseURL: string): VlConfig {
  const backend = vlBackendOf(input)
  if (backend === 'deepseek') {
    return {
      backend,
      baseURL: input.vlBaseURL ?? deepseekBaseURL,
      apiKey,
      model: input.vlModel ?? DEFAULT_DEEPSEEK_VL_MODEL,
      prompt: input.vlPrompt ?? DEFAULT_PROMPT,
    }
  }
  const env = process.env
  const qwen = readQwenConfig()
  return {
    backend,
    baseURL: input.vlBaseURL ?? env.DASHSCOPE_BASE_URL ?? qwen.DASHSCOPE_BASE_URL ?? DEFAULT_BAILIAN_BASE_URL,
    apiKey,
    model: input.vlModel ?? env.QWEN_MM_API_VL_MODEL ?? qwen.QWEN_MM_API_VL_MODEL ?? DEFAULT_BAILIAN_MODEL,
    prompt: input.vlPrompt ?? DEFAULT_PROMPT,
  }
}

/** Exponential backoff between retries (400ms, 800ms, 1600ms). */
function backoffDelay(attempt: number): number {
  return 400 * 2 ** (attempt - 1)
}

/** Minimal sleep helper for retry backoff. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Describe one image's encoded bytes through the VL endpoint, retrying
 * transient failures (network errors, HTTP 429, 5xx) up to three attempts so a
 * momentary endpoint hiccup does not fail the whole turn.
 * @returns the model's textual description.
 */
export async function describeImage(
  data: Uint8Array,
  mediaType: string,
  vl: VlConfig,
  signal?: AbortSignal,
): Promise<string> {
  const dataUrl = `data:${mediaType};base64,${Buffer.from(data).toString('base64')}`
  const body = {
    model: vl.model,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: dataUrl } },
        { type: 'text', text: vl.prompt },
      ],
    }],
    max_tokens: 2048,
  }
  const maxAttempts = 3

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) throw signal.reason

    let response: Response
    try {
      response = await fetch(`${vl.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${vl.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        ...signal === undefined ? {} : { signal },
      })
    } catch (error: unknown) {
      if (signal?.aborted) throw error
      if (attempt < maxAttempts) {
        await sleep(backoffDelay(attempt))
        continue
      }
      throw new LlmError(`llm-deepseek-image: VL request to ${vl.baseURL} failed`, 'TRANSPORT', { cause: error })
    }

    if (response.ok) {
      const parsed = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> }
      const content = parsed.choices?.[0]?.message?.content
      if (typeof content === 'string' && content.length > 0) return content
      if (attempt < maxAttempts) {
        await sleep(backoffDelay(attempt))
        continue
      }
      throw new LlmError('llm-deepseek-image: VL API returned no description', 'EMPTY_RESPONSE')
    }

    const retryable = response.status === 429 || response.status >= 500
    if (retryable && attempt < maxAttempts) {
      await sleep(backoffDelay(attempt))
      continue
    }

    let message = `llm-deepseek-image: VL API error (HTTP ${response.status})`
    try {
      const parsed = await response.json() as { error?: { message?: string } }
      if (parsed.error?.message) message = parsed.error.message
    } catch {
      // Keep the HTTP-status message when the error body is not JSON.
    }
    throw new LlmError(
      message,
      response.status === 401 || response.status === 403
        ? 'AUTH'
        : response.status >= 500 ? 'SERVER' : 'INVALID_REQUEST',
    )
  }

  /* v8 ignore next -- every path above either returns or throws. */
  throw new LlmError(`llm-deepseek-image: VL request to ${vl.baseURL} failed`, 'TRANSPORT')
}
