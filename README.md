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

`auth.usage` 按官方 `windows` 结构返回，**有 `amount`/`limit` 才会画出进度条**：

```json
{
  "user": "sonamu.liao@gmail.com",
  "balance": "$5.00",
  "windows": [
    { "name": "Telnyx 余额", "amount": 0, "limit": 5, "unit": "USD" },
    { "name": "额度到期", "used": 0, "display": "未提供（API 无到期字段）", "aside": true }
  ],
  "signIn": "kept"
}
```

- **进度**：`amount = limit - 剩余`。普通钱包（`/v2/balance`）没有"总额"字段，插件会把首次看到的最大余额记在 auth 记录的 `creditTotalUsd` 里作 `limit`，之后余额下降就是已用；充值导致余额变大时 `limit` 跟着变大。
- **Promotion 额度**（Pretrial 的 AI credits）：读 `GET /v2/balance/promo-credits`，用 `max_discount_amount` 作 `limit`、`remaining_credits` 作剩余、`period_end` 作到期时间，窗口名是「Telnyx AI 额度」，到期日会作为 `aside` 窗口和顶层 `until` 显示。
- **过期时间**：你升级后的这笔 **$5 是普通余额，`/v2/balance/promo-credits` 返回空**，Telnyx 公共 API 没有任何到期字段（`/v2/balance`、`/v2/whoami`、`/v2/api_keys` 的 `expires_at` 都是 null/无）。所以插件显示「未提供」而不是编一个日期。若 Portal 里有确切日期，设 `TELNYX_CREDIT_EXPIRES_AT=<ISO>` 即可显示。

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

