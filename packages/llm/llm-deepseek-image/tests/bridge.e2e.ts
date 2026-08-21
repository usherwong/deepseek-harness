/**
 * End-to-end bridge test: a real image → real VL description → real DeepSeek
 * answer, exercising ImageBridgeAdapter.stream's image-to-text rewrite.
 * Run from the repo root: pnpm exec tsx packages/llm/llm-deepseek-image/tests/bridge.e2e.ts
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { ImageBridgeAdapter } from '../src/adapter.ts'
import { resolveVlConfig } from '../src/vl.ts'

function deepseekKey(): string {
  const text = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
  const match = text.match(/DEEPSEEK_API_KEY:\s*(\S+)/)
  const key = match?.[1]
  if (!key) throw new Error('no DEEPSEEK_API_KEY in ~/.dsh/.credentials.yaml')
  return key
}

const png = readFileSync(new URL('./fixture.png', import.meta.url))
const ref: ImageAttachmentRef = {
  attachmentId: 'sha256:0000000000000000000000000000000000000000000000000000000000000000' as ImageAttachmentRef['attachmentId'],
  mediaType: 'image/png',
  bytes: png.byteLength,
  width: 128,
  height: 128,
}

const attachments = {
  readImage: async (r: ImageAttachmentRef) => ({ ref: r, data: new Uint8Array(png) }),
} as unknown as AttachmentStore

const connection = resolveAdapterOptions({}, undefined)
const inner = new DeepSeekAdapter({
  options: () => connection,
  resolveApiKey: async () => deepseekKey(),
  resolveUserId: () => getOrCreateAnonymousUserId(),
})

const adapter = new ImageBridgeAdapter({
  inner,
  resolveAttachments: () => attachments,
  resolveVl: async () => resolveVlConfig({}, deepseekKey(), connection.baseURL),
})

const message = {
  role: 'user',
  content: [
    { type: 'image', attachment: ref },
    { type: 'text', text: 'What is the dominant color in the image? Answer in one short sentence.' },
  ],
  source: { kind: 'user' },
} as unknown as Message

const options: GenerateOptions = {
  provider: 'deepseek-image',
  model: 'deepseek-v4-pro',
  messages: [message],
}

async function main(): Promise<void> {
  const text: string[] = []
  for await (const chunk of adapter.stream(options) as AsyncIterable<StreamChunk>) {
    if (chunk.type === 'text-delta') text.push(chunk.text)
  }
  console.log('=== DeepSeek answer ===')
  console.log(text.join(''))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
