# @deepseek-ai/dsh-llm-deepseek-image

An image-capable DeepSeek route. It registers the `deepseek-image` provider, which wraps the stock [`@deepseek-ai/dsh-llm-deepseek`](../llm-deepseek) adapter and:

- declares `inputModalities: ['text', 'image']`, so the host admits pasted images;
- describes every image block through a vision-language model and replaces it with a text block before the text-only DeepSeek model serializes the request.

## Config

All fields are optional. DeepSeek connection facts (`apiKeyEnv`, `baseURL`, `thinking`, `reasoningEffort`, `maxTokens`, `defaultContextWindow`, `models`, `streamIdleTimeoutMs`, `retryPolicy`) resolve exactly like `llm-deepseek`.

The vision bridge has two backends, selected by `vlBackend` (default `deepseek`):

| Backend | Key | Base URL | Model |
|---|---|---|---|
| `deepseek` (default) | `DEEPSEEK_API_KEY` | the DeepSeek route's `baseURL` (`https://api.deepseek.com`) | `deepseek-v4-flash-vision-exp` |
| `bailian` | `DASHSCOPE_API_KEY` → `~/.qwen-mm-plugins/config` | `DASHSCOPE_BASE_URL` → `~/.qwen-mm-plugins/config` → `https://dashscope.aliyuncs.com/compatible-mode/v1` | `QWEN_MM_API_VL_MODEL` → `qwen3.7-plus` |

`vlModel` and `vlBaseURL` override the backend defaults; `vlPrompt` overrides the description prompt.

A request without an image never touches the VL endpoint or the key.
