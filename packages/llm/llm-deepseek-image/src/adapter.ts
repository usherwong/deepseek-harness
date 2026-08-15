/**
 * ImageBridgeAdapter: a text-only DeepSeek adapter wrapped to declare image
 * input. When a request carries image blocks, each image is described by a
 * vision-language model and replaced with a text block before the inner
 * adapter serializes and streams it.
 * @module dsh-llm-deepseek-image/adapter
 */

import { contentHasImage, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { DeepSeekAdapter } from '@deepseek-ai/dsh-llm-deepseek'
import { describeImage, type VlConfig } from './vl.ts'

/** The bridge route advertises text plus image input. */
const IMAGE_MODALITIES: readonly ['text', 'image'] = ['text', 'image']

/** Constructor options for {@link ImageBridgeAdapter}. */
export interface ImageBridgeAdapterOptions {
  /** The wrapped stock DeepSeek adapter. */
  inner: DeepSeekAdapter
  /** Lazy attachment-service access; undefined means image input cannot be served. */
  resolveAttachments: () => AttachmentStore | undefined
  /** Resolve VL facts at request time (rejects when no key is available). */
  resolveVl: () => Promise<VlConfig>
}

/**
 * A DeepSeek adapter that accepts images by describing them first. Metadata
 * delegates to the inner adapter except `inputModalities`, which gains `image`
 * so the host admits pasted images; `stream` rewrites image blocks to text and
 * delegates, leaving every other request path byte-for-byte identical.
 */
export class ImageBridgeAdapter extends LlmAdapter {
  /** Text descriptions keyed by content-addressed attachment id, so each pasted
   *  image is described exactly once and later turns reuse the cached text. */
  private readonly imageCache = new Map<string, string>()

  constructor(private readonly config: ImageBridgeAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'DeepSeek (Image)' }
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.config.inner.providerRetryPolicy(provider)
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = await this.config.inner.listModels(provider)
    return models.map(model => ({ ...model, inputModalities: IMAGE_MODALITIES }))
  }

  override async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const info = await this.config.inner.resolveModel(provider, model, signal)
    return { ...info, inputModalities: IMAGE_MODALITIES }
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (!options.messages.some(message => contentHasImage(message.content))) {
      yield* this.config.inner.stream(options)
      return
    }
    const rewritten = await this.describeImages(options)
    yield* this.config.inner.stream(rewritten)
  }

  private async describeImages(options: GenerateOptions): Promise<GenerateOptions> {
    const attachments = this.config.resolveAttachments()
    if (attachments === undefined) {
      throw new LlmError(
        'llm-deepseek-image: image input requires the durable attachment service, which is not mounted',
        'UNSUPPORTED_CONTENT',
      )
    }
    const vl = await this.config.resolveVl()
    const messages = await Promise.all(
      options.messages.map(async message => ({
        ...message,
        content: await this.describeBlocks(message.content, attachments, vl, options.signal),
      })),
    )
    return { ...options, messages }
  }

  private async describeBlocks(
    blocks: readonly ContentBlock[],
    attachments: AttachmentStore,
    vl: VlConfig,
    signal?: AbortSignal,
  ): Promise<ContentBlock[]> {
    const out: ContentBlock[] = []
    for (const block of blocks) {
      if (block.type === 'image') {
        const key = String(block.attachment.attachmentId)
        let description = this.imageCache.get(key)
        if (description === undefined) {
          const stored = await attachments.readImage(block.attachment, signal)
          description = await describeImage(stored.data, stored.ref.mediaType, vl, signal)
          this.imageCache.set(key, description)
        }
        out.push({ type: 'text', text: `[Image content]\n${description}` })
      } else if (block.type === 'tool-result') {
        out.push({
          ...block,
          content: await this.describeBlocks(block.content, attachments, vl, signal),
        })
      } else {
        out.push(block)
      }
    }
    return out
  }
}
