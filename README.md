# opencode-telnyx-auth

Telnyx AI Inference as a magpie provider.

- 登录：Telnyx **API v2 Key**（Control Portal → API Keys）。
- 对话：OpenAI 兼容，`https://api.telnyx.com/v2/ai/openai`。
- 模型：登录后从 `GET https://api.telnyx.com/v2/ai/models` 实时拉取，只保留 Telnyx 自托管（`owned_by: Telnyx`）的对话模型。
- 余额：`GET https://api.telnyx.com/v2/balance`，按 magpie 的 `auth.usage` 标准格式返回（见下）。
- 图标：`package.json` 的 `magpie.icon` 内嵌 Telnyx 官网 favicon（`https://telnyx.com/favicon.ico`，750×750 PNG）。

支持的模型（随账号目录变化）：`zai-org/GLM-5.3-Flash`、`zai-org/GLM-5.3`、`zai-org/GLM-5.2`、`deepseek-ai/DeepSeek-V4.1-Flash-1017`、`moonshotai/Kimi-K3`、`Kimi-K3.1-Pro`、`Kimi-K2.6`、`MiniMaxAI/MiniMax-M3-MXFP8`、`Qwen/Qwen3.8-27B`、`google/gemma-4-26B-A4B-it`、`openai/gpt-oss-120b`（Preview）等，随账号目录变化。

> 只列 `service_tiers` 含 `default` 的模型：像 `google/gemma-4-31B-it` 是 priority-only，普通对话会报 `10015 does not support service_tier default`，插件直接不列出。

## 安装

```bash
# 先把之前那个 @telnyx/opencode 卸掉：它和本插件的供应商 id 都是 telnyx，
# 两个插件同时为 telnyx 提供 auth 会互相覆盖。
magpie plugin rm @telnyx/opencode

# 从 GitHub 仓库安装（Bun 拉取，无需本地文件夹）
magpie plugin add github:sssonamuuu/opencode-telnyx-auth
magpie plugin login telnyx        # 粘贴 Telnyx API Key
magpie plugin                     # 应显示 telnyx (Telnyx, N models) signed in
magpie provider test telnyx       # 发一条最小对话验证
```

在 GUI 里也可以：插件 → 添加插件 → 填 `github:sssonamuuu/opencode-telnyx-auth` → 在 telnyx 那一行登录。

仓库：https://github.com/sssonamuuu/opencode-telnyx-auth

## 说明

- 只列 Telnyx 自托管的模型（`owned_by: Telnyx`），也就是走 Telnyx 账号计费的那批。目录里还有 `openai/…`、`anthropic/…` 等 BYOK 模型，需要另外在 AI Gateway 里挂供应商 key，这里不列出。
- `speech-to-speech` 模型（Nemotron VoiceChat）不是对话接口，不列出。
- 该账号若调用对话返回 `403 / 10038 Feature not permitted`，见下：这是账号级别的限制，不是插件的问题。

## 用量（magpie quota / 账号卡片）

`auth.usage` 按官方格式返回，`magpie quota` 里会长这样：

```
telnyx · sonamu.liao@gmail.com (API key …KPxs) subscription  Telnyx 余额 5 USD left
```

返回结构：

```json
{
  "user": "sonamu.liao@gmail.com",       // 来自 GET /v2/whoami
  "balance": "$5.00",                    // 顶层余额字符串
  "windows": [
    { "name": "Telnyx 余额", "balance": 5, "unit": "USD", "display": "$5.00" }
  ],
  "signIn": "kept"
}
```

- 余额是**预付钱包**，所以用官方的 `balance` 字段（不写 `used`/`limit`），它会真正参与账号选择；`pending` 有值时会额外加一个 `aside` 的"待结算"窗口。
- **过期时间**：Telnyx 公共 API（`/v2/balance`、`/v2/whoami`）**不返回**额度或套餐的到期时间（Portal 里那句 "days left" 只在网页端）。所以插件不编造；如果你在 Portal 看到具体到期时间，设环境变量 `TELNYX_CREDIT_EXPIRES_AT=<ISO 时间>`（例如 `2026-12-20T00:00:00+08:00`），magpie 会把 `until` 显示在账号卡片上。`/v2/api_keys` 里 key 的 `expires_at` 目前是 `null`，也不适用。

## 账号侧限制（官方明确规定，不是插件问题）

Telnyx 官方 [Pretrial Account Privileges & Limitations](https://developers.telnyx.com/docs/account-setup/levels-and-capabilities/pretrial) 原文：

> **AI Assistant creation and Inference require a Trial account or higher — pretrial accounts cannot create AI Assistants or use Inference.**
> Pretrial AI credits can be used with Cloud Storage, subject to the limitations below.

也就是说：Pretrial 账号的 **$25 AI 额度只能用在 Cloud Storage 上，不能调 Inference**；网上"$25 免费用 Kimi/GLM"的说法与官方权限页冲突，Pretrial 账号的 Inference 请求会得到 `403 10038 Feature not permitted ... /upgrade`。

要用 Inference 必须升级：

- **Trial**：需通过 fraud review（LinkedIn 或 GitHub 验证 / AI agent evaluation），有 **$5** 测试额度；升级后原来的 `$25` 会被替换成 `$5`。
- **Paid**：再需要手机号、服务地址、绑卡。

升级入口：Portal → Account Level → Upgrade，或参考 [Account Upgrade](https://developers.telnyx.com/docs/account-setup/account-upgrade)。

插件已经把这个 403/10038 转成一句中文提示（`telnyx_account_level`），不会再只抛原始 403。升级到 Trial 后无需改插件，直接重试即可。

