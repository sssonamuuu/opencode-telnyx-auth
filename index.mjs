// magpie-telnyx-auth — Telnyx AI Inference provider plugin for magpie.
//
// Signs in with a Telnyx API v2 key, forwards OpenAI-compatible chat
// completions to Telnyx's Inference API, lists the account's live catalog of
// Telnyx-hosted models, and reads the account's cash balance.
//
// Docs: https://developers.telnyx.com/docs/inference/getting-started
//   base URL : https://api.telnyx.com/v2/ai/openai
//   models   : GET https://api.telnyx.com/v2/ai/models   (Bearer key)
//
// Only Telnyx-hosted models are listed here: those are the ones billed to the
// Telnyx account (and therefore covered by the Pretrial $25 AI credit). The
// catalog also returns bring-your-own-key models (openai/, anthropic/, …)
// which need a provider key attached to a gateway token group; they are not
// served by an account API key, so they are left out.

const PROVIDER = "telnyx"
const NAME = "Telnyx"

const origin = () => (process.env.TELNYX_ORIGIN?.trim() || "https://api.telnyx.com").replace(/\/+$/, "")
const openAIBase = () => `${origin()}/v2/ai/openai`
const modelsURL = () => `${origin()}/v2/ai/models`
const balanceURL = () => `${origin()}/v2/balance`
const whoamiURL = () => `${origin()}/v2/whoami`
const promoURL = () => `${origin()}/v2/balance/promo-credits`

// The tasks the OpenAI-compatible chat endpoint serves. Telnyx uses both
// spellings across the catalog ("text-generation", "text generation") and
// tags Gemma as "text-to-text"; "speech-to-speech" models are not chat models.
const CHAT_TASKS = new Set(["text-generation", "text generation", "text-to-text"])

// What the provider shows before anyone signs in. Once a key is stored,
// provider.models() replaces this with the account's live catalog.
const FALLBACK_MODELS = {
  "zai-org/GLM-5.3-Flash": { name: "GLM-5.3-Flash", limit: { context: 1048576, output: 131072 }, modalities: { input: ["text", "image"], output: ["text"] }, tool_call: true },
  "zai-org/GLM-5.3": { name: "GLM-5.3", limit: { context: 1048576, output: 131072 }, tool_call: true },
  "deepseek-ai/DeepSeek-V4.1-Flash-1017": { name: "DeepSeek-V4.1-Flash", limit: { context: 1048576, output: 64000 }, modalities: { input: ["text", "image"], output: ["text"] }, tool_call: true },
  "moonshotai/Kimi-K3": { name: "Kimi-K3", limit: { context: 1048576, output: 131072 }, modalities: { input: ["text", "image"], output: ["text"] }, tool_call: true },
  "MiniMaxAI/MiniMax-M3-MXFP8": { name: "MiniMax-M3", limit: { context: 1000000, output: 131072 }, modalities: { input: ["text", "image"], output: ["text"] }, tool_call: true },
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined)
const price = (v) => {
  const n = typeof v === "string" ? Number(v) : v
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined
}

// One catalog row -> one magpie model entry.
function modelEntry(m) {
  const id = String(m.id)
  const short = id.includes("/") ? id.split("/").pop() || id : id
  const entry = { name: short }

  const context = num(m.context_length)
  const output = num(m.max_completion_tokens)
  if (context !== undefined || output !== undefined) {
    entry.limit = {
      ...(context !== undefined ? { context } : {}),
      ...(output !== undefined ? { output } : {}),
    }
  }

  if (m.is_vision_supported === true) {
    entry.attachment = true
    entry.modalities = { input: ["text", "image"], output: ["text"] }
  }

  const efforts = Array.isArray(m.supported_reasoning_efforts)
    ? m.supported_reasoning_efforts.map((e) => String(e)).filter(Boolean)
    : []
  if (efforts.length) {
    entry.reasoning = true
    entry.variants = Object.fromEntries(efforts.map((e) => [e, {}]))
  }

  // Chat completions support tool calls on all Telnyx-hosted chat models.
  entry.tool_call = true

  const p = m.pricing || {}
  const cost = {}
  for (const [from, to] of [["input", "input"], ["output", "output"], ["cached_prompt", "cache_read"]]) {
    const v = price(p[from])
    if (v !== undefined) cost[to] = v
  }
  if (Object.keys(cost).length) entry.cost = cost // USD per 1M tokens

  return entry
}


// Remember the biggest wallet balance seen on this account, on the auth
// record, so a plain (non-promotion) balance can still show a progress bar.
async function rememberTotalCredit(client, getAuth, balance) {
  let previous = 0
  let auth
  try {
    auth = await getAuth()
    const n = Number(auth?.creditTotalUsd)
    if (Number.isFinite(n)) previous = n
  } catch {}
  const next = Math.max(previous, Number.isFinite(balance) ? balance : 0)
  if (next > previous && client?.auth?.set && auth) {
    try {
      await client.auth.set({ path: { id: PROVIDER }, body: { ...auth, creditTotalUsd: next } })
    } catch {}
  }
  return next
}

export async function TelnyxAuthPlugin({ client } = {}) {
  return {
    // Declare the provider before anyone signs in. ??= keeps a provider block
    // the user edited in plugins.json.
    async config(cfg) {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: NAME,
        npm: "@ai-sdk/openai-compatible",
        api: openAIBase(), // chat completions
        models: FALLBACK_MODELS,
      }
    },

    auth: {
      provider: PROVIDER,
      methods: [{ type: "api", label: "Telnyx API Key", placeholder: "KEY…" }],

      // What every request for this account carries. A plain bearer key is
      // all Telnyx's OpenAI-compatible endpoint wants; the fetch here only
      // turns Telnyx's account-level refusal into a message the user can act
      // on, since a Pretrial account cannot use Inference at all.
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) return {}
        return {
          baseURL: openAIBase(),
          async fetch(input, init = {}) {
            const headers = new Headers(init.headers)
            headers.set("authorization", `Bearer ${auth.key}`)
            const res = await fetch(input, { ...init, headers })
            if (res.status === 403) {
              const text = await res.clone().text().catch(() => "")
              if (text.includes("10038")) {
                return new Response(
                  JSON.stringify({
                    error: {
                      type: "telnyx_account_level",
                      message:
                        "Telnyx 账号级别不允许调用 Inference：Pretrial 账号不能用 Inference（官方说明见 README）。请到 portal.telnyx.com → Account Level 升级到 Trial 或更高，再换用该账号的 API Key。",
                    },
                  }),
                  { status: 503, headers: { "content-type": "application/json" } },
                )
              }
            }
            return res
          },
        }
      },

      // magpie's own hook: the account's wallet. Telnyx exposes a prepaid
      // USD balance at GET /v2/balance; a promotion (Pretrial AI credits) has
      // its own grant with total/remaining/period_end at
      // GET /v2/balance/promo-credits. We return a normal usage window so
      // magpie draws a progress bar: amount spent = limit - remaining.
      async usage(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) return { error: "not signed in", windows: [] }
        try {
          const headers = { authorization: `Bearer ${auth.key}`, accept: "application/json" }
          const [balRes, promoRes, meRes] = await Promise.all([
            fetch(balanceURL(), { headers, signal: AbortSignal.timeout(15000) }),
            fetch(promoURL(), { headers, signal: AbortSignal.timeout(15000) }).catch(() => null),
            fetch(whoamiURL(), { headers, signal: AbortSignal.timeout(15000) }).catch(() => null),
          ])
          if (!balRes.ok) return { error: `Telnyx answered ${balRes.status}`, windows: [] }

          const b = (await balRes.json().catch(() => null))?.data ?? {}
          const balance = Number(b.balance)
          const available = Number(b.available_credit)
          const pending = Number(b.pending)
          let currency = typeof b.currency === "string" && b.currency ? b.currency : "USD"
          const money = (v) => `$${v.toFixed(2)}`

          const promo = (await promoRes?.json?.().catch(() => null))?.data?.[0]
          const promoTotal = promo ? Number(promo.max_discount_amount) : NaN
          const promoRemaining = promo ? Number(promo.remaining_credits) : NaN
          const promoEnd = promo && typeof promo.period_end === "string" ? promo.period_end : undefined

          let remaining = balance
          let total
          let name = "Telnyx 余额"
          if (Number.isFinite(promoTotal) && promoTotal > 0) {
            // A promotion grant: its own total, remaining and end date.
            total = promoTotal
            remaining = Number.isFinite(promoRemaining) ? promoRemaining : promoTotal
            if (typeof promo.currency === "string" && promo.currency) currency = promo.currency
            name = "Telnyx AI 额度"
          } else {
            // A plain wallet: remember the largest balance seen, so spend
            // is measurable across plugin-host restarts (stored on the auth
            // record). No public API gives a total or an expiry for it.
            total = await rememberTotalCredit(client, getAuth, balance)
          }

          const until = promoEnd || process.env.TELNYX_CREDIT_EXPIRES_AT?.trim()
          const expiryText = until ? `到期 ${String(until).slice(0, 10)}` : "到期 未提供（API 无字段）"

          const windows = []
          if (Number.isFinite(remaining) && Number.isFinite(total) && total > 0) {
            const usedAmount = Math.max(0, total - remaining)
            // `used` is a percentage, which is what draws the progress bar;
            // `display` carries the money amounts and the expiry in words.
            const percent = Math.max(0, Math.min(100, (usedAmount / total) * 100))
            windows.push({ name, used: percent, unit: currency, display: `${money(remaining)} / ${money(total)} · ${expiryText}` })
          } else if (Number.isFinite(balance)) {
            windows.push({ name, balance, unit: currency, display: money(balance) })
          }

          if (Number.isFinite(pending) && pending > 0) {
            windows.push({ name: "待结算", used: 0, display: money(pending), aside: true })
          }
          if (Number.isFinite(available) && Number.isFinite(balance) && available !== balance) {
            windows.push({ name: "可用额度", used: 0, display: money(available), aside: true })
          }

          let user
          if (meRes?.ok) {
            const me = (await meRes.json().catch(() => null))?.data
            if (typeof me?.user_email === "string" && me.user_email) user = me.user_email
          }

          const out = { windows, signIn: "kept" }
          if (Number.isFinite(balance)) out.balance = money(balance)
          if (user) out.user = user
          if (until) out.until = until
          return out
        } catch (e) {
          return { error: String(e?.message ?? e), windows: [] }
        }
      },
    },

    // magpie's own hook: this account's models, pulled live from Telnyx.
    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        if (auth?.type !== "api" || !auth.key) return provider.models
        try {
          const res = await fetch(modelsURL(), {
            headers: { authorization: `Bearer ${auth.key}`, accept: "application/json" },
            signal: AbortSignal.timeout(15000),
          })
          if (!res.ok) return provider.models // keep the list magpie had
          const payload = await res.json().catch(() => null)
          const list = Array.isArray(payload?.data) ? payload.data : []
          const out = {}
          for (const m of list) {
            if (!m || typeof m.id !== "string") continue
            if (String(m.owned_by ?? "").toLowerCase() !== "telnyx") continue // skip BYOK rows
            if (!CHAT_TASKS.has(String(m.task ?? ""))) continue // skip speech-to-speech / embeddings
            // A model that does not offer the default service tier (e.g.
            // gemma-4-31B-it is priority-only) rejects ordinary chat calls
            // with 10015, so leave it out rather than list a model that 400s.
            const tiers = Array.isArray(m.service_tiers) ? m.service_tiers : []
            if (tiers.length && !tiers.includes("default")) continue
            out[m.id] = { ...(provider.models?.[m.id] ?? {}), ...modelEntry(m) }
          }
          if (!Object.keys(out).length) return provider.models
          return out
        } catch {
          return provider.models
        }
      },
    },
  }
}
