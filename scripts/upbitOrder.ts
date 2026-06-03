/**
 * Upbit authenticated REST API — order placement, balance, position sync.
 * Uses JWT (HS256) + SHA512 query hash per Upbit Open API spec.
 * Node.js only — do not import from browser src/.
 */
import crypto from "node:crypto";
import { v4 as uuidv4 } from "uuid";

const UPBIT_BASE_URL = "https://api.upbit.com";
const REQUEST_TIMEOUT_MS = 10_000;
const RETRY_BASE_MS = 500;
const MAX_READ_RETRIES = 3;

function sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }

// ── Types ──────────────────────────────────────────────────────────────────

export interface UpbitAccount {
  currency: string;       // "KRW" | "BTC" | ...
  balance: string;        // available balance
  locked: string;         // in pending orders
  avg_buy_price: string;  // average buy price in KRW
}

export interface UpbitOrder {
  uuid: string;
  side: "bid" | "ask";
  ord_type: "price" | "market" | "limit";
  state: "wait" | "watch" | "done" | "cancel";
  market: string;
  created_at: string;
  price: string | null;           // KRW amount (for market buy)
  volume: string | null;          // coin volume (for market sell)
  avg_price: string;              // 평균 체결가
  executed_volume: string;        // 체결된 코인 수량
  paid_fee: string;               // 지불 수수료 (KRW)
  executed_funds: string;         // 체결 금액 (KRW, 수수료 차감 전)
}

// ── JWT auth ───────────────────────────────────────────────────────────────

function buildJwt(accessKey: string, secretKey: string, queryParams?: Record<string, string>): string {
  let payload: Record<string, string> = {
    access_key: accessKey,
    nonce: uuidv4(),
  };

  if (queryParams && Object.keys(queryParams).length > 0) {
    const qs = new URLSearchParams(queryParams).toString();
    const hash = crypto.createHash("sha512").update(qs).digest("hex");
    payload = { ...payload, query_hash: hash, query_hash_alg: "SHA512" };
  }

  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secretKey).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

async function upbitRequest<T>(
  accessKey: string,
  secretKey: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  params?: Record<string, string>,
  body?: Record<string, string>,
): Promise<T> {
  // GET: 타임아웃·429·5xx 에 한해 최대 MAX_READ_RETRIES 재시도.
  // POST/DELETE: 재시도 없음 — 중복 주문 방지.
  const maxAttempts = method === "GET" ? MAX_READ_RETRIES : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // DELETE는 GET처럼 query param 기반; POST는 body 기반
    const jwtParams = method === "POST" ? body : params;
    const jwt = buildJwt(accessKey, secretKey, jwtParams);

    const url = (method === "GET" || method === "DELETE") && params
      ? `${UPBIT_BASE_URL}${path}?${new URLSearchParams(params)}`
      : `${UPBIT_BASE_URL}${path}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        signal: controller.signal,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      clearTimeout(timeoutId);
      if (method === "GET" && attempt < maxAttempts) {
        await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
        continue;
      }
      throw e;
    }
    clearTimeout(timeoutId);

    if (res.status === 429) {
      if (method === "GET" && attempt < maxAttempts) {
        const retryAfterMs = parseInt(res.headers.get("Retry-After") ?? "1", 10) * 1000;
        await sleep(Math.max(retryAfterMs, RETRY_BASE_MS * attempt));
        continue;
      }
      const text = await res.text();
      throw new Error(`Upbit rate-limited: ${text}`);
    }

    if (res.status >= 500 && method === "GET" && attempt < maxAttempts) {
      await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
      continue;
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Upbit ${method} ${path} → ${res.status}: ${text}`);
    }

    return res.json() as Promise<T>;
  }

  throw new Error(`Upbit ${method} ${path} — ${maxAttempts}회 재시도 후 실패`);
}

// ── Public API ─────────────────────────────────────────────────────────────

/** 전체 잔고 조회 */
export async function getAccounts(accessKey: string, secretKey: string): Promise<UpbitAccount[]> {
  return upbitRequest<UpbitAccount[]>(accessKey, secretKey, "GET", "/v1/accounts");
}

/** KRW 사용가능 잔고 */
export async function getKrwBalance(accessKey: string, secretKey: string): Promise<number> {
  const accounts = await getAccounts(accessKey, secretKey);
  const krw = accounts.find((a) => a.currency === "KRW");
  return krw ? parseFloat(krw.balance) : 0;
}

/** 특정 코인 보유량 (예: "DOGE" → 잔고) */
export async function getCoinBalance(accessKey: string, secretKey: string, currency: string): Promise<{ balance: number; avgBuyPrice: number }> {
  const accounts = await getAccounts(accessKey, secretKey);
  const coin = accounts.find((a) => a.currency === currency);
  if (!coin) return { balance: 0, avgBuyPrice: 0 };
  return {
    balance: parseFloat(coin.balance) + parseFloat(coin.locked),
    avgBuyPrice: parseFloat(coin.avg_buy_price),
  };
}

/**
 * 시장가 매수 — KRW 금액만큼 구매
 * @param krwAmount  예: 50000 (5만원)
 */
export async function placeMarketBuy(
  accessKey: string,
  secretKey: string,
  market: string,
  krwAmount: number,
): Promise<UpbitOrder> {
  if (krwAmount < 5000) throw new Error(`최소 주문 금액은 5,000원 (요청: ${krwAmount}원)`);
  return upbitRequest<UpbitOrder>(accessKey, secretKey, "POST", "/v1/orders", undefined, {
    market,
    side: "bid",
    price: String(Math.floor(krwAmount)),
    ord_type: "price",
  });
}

/**
 * 시장가 매도 — 보유 수량 전량 매도
 * @param volume  코인 수량 (예: "1000.5")
 */
export async function placeMarketSell(
  accessKey: string,
  secretKey: string,
  market: string,
  volume: string,
): Promise<UpbitOrder> {
  return upbitRequest<UpbitOrder>(accessKey, secretKey, "POST", "/v1/orders", undefined, {
    market,
    side: "ask",
    volume,
    ord_type: "market",
  });
}

/** 주문 상태 조회 */
export async function getOrder(accessKey: string, secretKey: string, uuid: string): Promise<UpbitOrder> {
  return upbitRequest<UpbitOrder>(accessKey, secretKey, "GET", "/v1/order", { uuid });
}

/** 주문 취소 */
export async function cancelOrder(accessKey: string, secretKey: string, uuid: string): Promise<UpbitOrder> {
  return upbitRequest<UpbitOrder>(accessKey, secretKey, "DELETE", "/v1/order", { uuid });
}
