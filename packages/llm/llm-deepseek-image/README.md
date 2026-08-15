# @deepseek-ai/dsh-llm-deepseek-image

English | [中文](README.zh.md)

An image-capable DeepSeek route. It registers the `deepseek-image` provider, which wraps the stock [`@deepseek-ai/dsh-llm-deepseek`](../llm-deepseek) adapter and:

- declares `inputModalities: ['text', 'image']`, so the host admits pasted images;
- describes every image block through an OpenAI-compatible vision-language endpoint (Bailian/DashScope compatible-mode, default model `qwen3.7-plus`) and replaces it with a text block before the text-only DeepSeek model serializes the request.

## Config

All fields are optional. DeepSeek connection facts (`apiKeyEnv`, `baseURL`, `thinking`, `reasoningEffort`, `maxTokens`, `defaultContextWindow`, `models`, `streamIdleTimeoutMs`, `retryPolicy`) resolve exactly like `llm-deepseek`. The VL bridge fields resolve with precedence **explicit config → environment → `~/.qwen-mm-plugins/config` → default**:

| Key | Default | Meaning |
|---|---|---|
| `vlBaseURL` | `DASHSCOPE_BASE_URL` → `~/.qwen-mm-plugins/config` → `https://dashscope.aliyuncs.com/compatible-mode/v1` | OpenAI-compatible endpoint base. |
| `vlApiKey` | `DASHSCOPE_API_KEY` → `~/.qwen-mm-plugins/config` | Bearer token for the VL endpoint. |
| `vlModel` | `QWEN_MM_API_VL_MODEL` → `qwen3.7-plus` | Vision-language model id. |
| `vlPrompt` | a full description + verbatim text-transcription prompt | Prompt paired with each image. |

A request without an image never touches the VL endpoint or the key.
