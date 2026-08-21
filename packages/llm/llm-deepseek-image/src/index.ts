/**
 * Register an image-capable DeepSeek route (`deepseek-image`) that wraps the
 * stock DeepSeek chat-completions adapter: pasted images are described by a
 * vision-language model and replaced with text before the text-only DeepSeek
 * model sees them. The vision backend defaults to DeepSeek's own
 * `deepseek-v4-flash-vision-exp` (one DEEPSEEK_API_KEY covers chat + images)
 * and can be switched back to the Bailian/DashScope endpoint. DeepSeek
 * connection facts resolve per request exactly like the stock `llm-deepseek`
 * plugin; the Bailian key resolves through the credentials seam (the web
 * Models page writes it), then the environment, then `~/.qwen-mm-plugins/config`.
 * @module @deepseek-ai/dsh-llm-deepseek-image
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { assertUsableApiKey, LlmError, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { getOrCreateAnonymousUserId, type AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DeepSeekAdapter,
  resolveAdapterOptions,
} from '@deepseek-ai/dsh-llm-deepseek'
import type { DeepSeekCatalogModel, DeepSeekConnectionOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { ImageBridgeAdapter } from './adapter.ts'
import { readQwenConfig, resolveVlConfig, vlBackendOf, writeQwenConfig, type VlBackend, type VlConfig } from './vl.ts'

export const name = 'llm-deepseek-image'
export const inject = ['llm']

/** The single provider route this plugin owns. */
const PROVIDER = 'deepseek-image'
const NS = settingsNamespace('llm-deepseek-image')
const DEFAULT_VL_API_KEY_ENV = 'DASHSCOPE_API_KEY'

const DEFAULT_MODELS: DeepSeekCatalogModel[] = [
  { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', contextWindow: DEFAULT_CONTEXT_WINDOW },
]

/** Plugin config: the stock DeepSeek connection facts plus the VL bridge. */
export interface Config {
  /** Credential reference (env var name) resolved per request; defaults to `DEEPSEEK_API_KEY`. */
  apiKeyEnv?: string
  /** DeepSeek endpoint base; falls back to $DEEPSEEK_BASE_URL, then the public API. */
  baseURL?: string
  /** Deployment thinking policy. */
  thinking?: 'enabled' | 'disabled'
  /** Default thinking effort. */
  reasoningEffort?: 'off' | 'high' | 'max'
  /** Default per-request output cap. */
  maxTokens?: number
  /** Context capacity used when the selected model has no exact value. */
  defaultContextWindow?: number
  /** Advisory models; defaults to V4 Flash and V4 Pro. */
  models?: DeepSeekCatalogModel[]
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs?: number
  /** Provider-owned model-request retry policy. */
  retryPolicy?: RetryPolicyConfig
  /** Vision backend; defaults to `deepseek` (DeepSeek's own vision model). */
  vlBackend?: VlBackend
  /** Bailian key credential reference; defaults to `DASHSCOPE_API_KEY` (used by the `bailian` backend). */
  vlApiKeyEnv?: string
  /** OpenAI-compatible base URL override for the vision backend. */
  vlBaseURL?: string
  /** Vision-language model id override; `deepseek` defaults to `deepseek-v4-flash-vision-exp`, `bailian` to `qwen3.7-plus`. */
  vlModel?: string
  /** Prompt paired with each image. */
  vlPrompt?: string
}

const catalogModel: z<DeepSeekCatalogModel> = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
})

export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().role('credential-ref').default('DEEPSEEK_API_KEY'),
  baseURL: z.string(),
  thinking: z.union(['enabled', 'disabled']),
  reasoningEffort: z.union(['off', 'high', 'max']),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  models: z.array(catalogModel).default(DEFAULT_MODELS),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
  vlBackend: z.union(['deepseek', 'bailian']),
  vlApiKeyEnv: z.string().role('credential-ref').default(DEFAULT_VL_API_KEY_ENV),
  vlBaseURL: z.string(),
  vlModel: z.string(),
  vlPrompt: z.string(),
})

export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let lastGood: DeepSeekConnectionOptions | undefined
  const options = (): DeepSeekConnectionOptions => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveAdapterOptions(raw, launchEnvironmentOf(ctx))
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      if (lastGood === undefined) throw error
      lastRaw = raw
      ctx.logger.error('llm-deepseek-image: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return lastGood
    }
  }
  options()

  const resolveApiKey = async (connection: DeepSeekConnectionOptions): Promise<string> => {
    const ref = connection.apiKeyEnv
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined) return assertUsableApiKey(hit.value, 'llm-deepseek-image', ref)
    } else {
      const ambient = launchEnvironmentOf(ctx).get(ref)
      if (ambient !== undefined && ambient.value.length > 0) {
        return assertUsableApiKey(ambient.value, 'llm-deepseek-image', ref)
      }
    }
    throw new LlmError(
      `llm-deepseek-image: no API key for provider route "${PROVIDER}"; store ${ref} through the credentials`
      + ' service (the web Models page writes it), or export it in the launching environment',
      'MISSING_CREDENTIAL',
    )
  }

  /** Resolve the Bailian key: credentials seam → environment → ~/.qwen-mm-plugins/config. */
  const resolveVlApiKey = async (): Promise<string> => {
    const ref = credentialRef(current().vlApiKeyEnv ?? DEFAULT_VL_API_KEY_ENV)
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined && hit.value.length > 0) return hit.value
    }
    const ambient = launchEnvironmentOf(ctx).get(ref)?.value ?? process.env[String(ref)]
    if (ambient !== undefined && ambient.length > 0) return ambient
    const fromFile = readQwenConfig()[String(ref)]
    if (fromFile !== undefined && fromFile.length > 0) return fromFile
    throw new LlmError(
      `llm-deepseek-image: no vision-language API key; store ${String(ref)} through the credentials`
      + ' service, export it, or add it to ~/.qwen-mm-plugins/config',
      'MISSING_CREDENTIAL',
    )
  }

  const resolveVl = async (): Promise<VlConfig> => {
    const raw = current()
    if (vlBackendOf(raw) === 'deepseek') {
      const connection = options()
      const apiKey = await resolveApiKey(connection)
      return resolveVlConfig(raw, apiKey, connection.baseURL)
    }
    const apiKey = await resolveVlApiKey()
    return resolveVlConfig(raw, apiKey, '')
  }

  // Mirror the Bailian credential into ~/.qwen-mm-plugins/config so the
  // bundled qwen-mm-plugins MCP servers (Python) also see it: they read only
  // the environment or that file, never the DSH credentials store. One
  // Models-page entry then covers both the bridge and the media tools.
  const vlRefName = (): string => current().vlApiKeyEnv ?? DEFAULT_VL_API_KEY_ENV
  const syncQwenKey = async (): Promise<void> => {
    try {
      const ref = credentialRef(vlRefName())
      const credentials = ctx.get('credentials')
      if (credentials === undefined) return
      const hit = await credentials.resolve(ref)
      if (hit !== undefined && hit.value.length > 0) {
        writeQwenConfig({ [String(ref)]: hit.value })
      }
    } catch (error) {
      ctx.logger.warn('llm-deepseek-image: failed to mirror the Bailian key to ~/.qwen-mm-plugins/config')
      ctx.logger.warn(error)
    }
  }
  void syncQwenKey()
  ctx.on('credentials/updated', (ref) => {
    if (String(ref) === vlRefName()) void syncQwenKey()
  })

  let userId: AnonymousUserId | undefined
  const resolveUserId = (): AnonymousUserId => userId ??= getOrCreateAnonymousUserId()

  const inner = new DeepSeekAdapter({ options, resolveApiKey, resolveUserId })
  const adapter = new ImageBridgeAdapter({
    inner,
    resolveAttachments: () => ctx.get('attachments'),
    resolveVl,
  })

  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'DeepSeek (Image)', settingsNs: NS, settingsPath: [] },
  ])
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  let registeredPolicy = options().retryPolicy
  const ensureRegistrationFacts = (): void => {
    const policy = options().retryPolicy
    if (deepEqualJson(policy, registeredPolicy)) return
    registration.replace([PROVIDER])
    registeredPolicy = policy
  }
  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange: ensureRegistrationFacts,
  })
}
