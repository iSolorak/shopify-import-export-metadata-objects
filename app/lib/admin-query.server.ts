// One Admin API request, with the leaky bucket accounted for.
//
// Seven modules here had grown a byte-identical private `query` helper: post
// the document, reject a non-2xx or a populated `errors` array, hand back
// `data`. This is that function, written once, plus the one thing every copy of
// it was missing — waiting when Shopify says to wait.
//
// ## Why that matters now
//
// The Admin API is a leaky bucket: a query costs points, the bucket refills at
// a fixed rate, and a request arriving at an empty bucket is refused with
// `THROTTLED` rather than queued. The refusal is an HTTP **200** carrying an
// `errors` array, which is why the old helper turned it into a thrown
// `Error: Throttled` and killed whatever run it was in the middle of.
//
// That was survivable while a run was one request over a couple of hundred
// products. It stopped being survivable when `app.product-update.tsx` started
// walking a whole catalogue: the product lookup is this app's most expensive
// query, and a few hundred of them back to back will empty any store's bucket.
// Throttling there is not a fault to report, it is the API working as designed
// and asking for a pause.
//
// So this waits and tries again. The wait is computed from the response rather
// than guessed: `extensions.cost.throttleStatus` says how many points are
// available and how fast they come back, which is exactly how long the next
// attempt needs to sit out. `Retry-After` wins when present, since a 429 from
// the edge is not about query cost at all.
//
// What it deliberately does not do is retry anything else. A validation error,
// a bad document, a revoked token: those are answers, and repeating them would
// turn one clear failure into six slow ones.

/** Structural, matching the `Admin` each caller already declares. */
type Admin = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

type GraphQLError = {
  message: string;
  extensions?: { code?: string } | null;
};

type ThrottleStatus = {
  currentlyAvailable: number;
  restoreRate: number;
  maximumAvailable: number;
};

type Body<T> = {
  data?: T;
  errors?: GraphQLError[];
  extensions?: {
    cost?: {
      requestedQueryCost?: number;
      throttleStatus?: ThrottleStatus;
    };
  };
};

/**
 * Waits before giving up on a throttled request.
 *
 * Six is long enough to ride out an empty bucket — the worst honest wait is the
 * cost of one query divided by the restore rate, a few seconds — while still
 * failing in a bounded time if the store is being hammered by something else
 * entirely, which is not this app's to wait out.
 */
const THROTTLE_RETRIES = 6;

/** Never sleep longer than this in one go, however the arithmetic comes out. */
const MAX_WAIT_MS = 20_000;

/** Nor shorter: a retry that arrives instantly just spends another attempt. */
const MIN_WAIT_MS = 1_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Did this response say "slow down"? */
function isThrottled(response: Response, body: Body<unknown>): boolean {
  if (response.status === 429) return true;
  return Boolean(
    body.errors?.some(
      (error) =>
        error.extensions?.code === "THROTTLED" ||
        /throttl/i.test(error.message),
    ),
  );
}

/**
 * How long to wait before trying again.
 *
 * In order of preference: what the response asked for, what the bucket
 * arithmetic implies, and failing both an exponential back-off — the last only
 * really applies to a 429 from in front of the API, which carries no cost
 * extension of its own.
 */
function waitFor(
  response: Response,
  body: Body<unknown>,
  attempt: number,
): number {
  const retryAfter = Number(response.headers.get("Retry-After"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, MAX_WAIT_MS);
  }

  const cost = body.extensions?.cost;
  const status = cost?.throttleStatus;
  if (status && status.restoreRate > 0) {
    // The refused query's own cost is what has to be back in the bucket before
    // it can run. `maximumAvailable` is the ceiling: asking for more than the
    // bucket can ever hold would wait forever, so it is capped there and left
    // to fail honestly instead.
    const needed = Math.min(
      cost?.requestedQueryCost ?? status.maximumAvailable,
      status.maximumAvailable,
    );
    const shortfall = needed - status.currentlyAvailable;
    if (shortfall > 0) {
      return Math.min(
        Math.max((shortfall / status.restoreRate) * 1000, MIN_WAIT_MS),
        MAX_WAIT_MS,
      );
    }
    return MIN_WAIT_MS;
  }

  return Math.min(MIN_WAIT_MS * 2 ** attempt, MAX_WAIT_MS);
}

/**
 * Run one Admin GraphQL document, waiting out throttling, and return `data`.
 *
 * Throws on anything else, which is the contract every caller was already
 * written against: mutations return their `userErrors` in `data` and report
 * them per row, so a throw here means the request itself did not happen.
 */
export async function adminQuery<T>(
  admin: Admin,
  document: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const response = await admin.graphql(document, { variables });
    const body = (await response.json()) as Body<T>;

    if (isThrottled(response, body) && attempt < THROTTLE_RETRIES) {
      await sleep(waitFor(response, body, attempt));
      continue;
    }

    // A GraphQL API can return HTTP 200 with a populated `errors` array, so the
    // status alone is not enough to conclude the call succeeded.
    if (!response.ok || body.errors) {
      const detail = body.errors?.map((error) => error.message).join("; ");
      throw new Error(
        detail || `Admin API request failed (${response.status})`,
      );
    }

    return body.data as T;
  }
}
