import { createHash, createHmac } from 'node:crypto';

/**
 * Amazon Bedrock runtime client.
 *
 * A REAL client, not a stand-in: it signs requests with SigV4 and calls
 * `bedrock-runtime` InvokeModel. It is unconfigured in a checkout without AWS
 * credentials, and in that state it says so — `status: 'UNCONFIGURED'` — rather
 * than returning invented prose. Nothing here pretends an AWS call happened.
 *
 * Signing is implemented directly because this repository carries no AWS SDK
 * and the algorithm is short and stable. The trade is that only the one API
 * this feature needs is supported; the AWS SDK would be the right answer the
 * moment a second call appears.
 *
 * Bedrock is the NARRATOR. It never produces a number: the probability, the
 * anomaly ratio and the metrics are computed deterministically and passed in,
 * and the prompt instructs the model to reuse them verbatim.
 */

const SERVICE = 'bedrock';
const ALGORITHM = 'AWS4-HMAC-SHA256';

/** Read AWS configuration from the environment only. */
export function bedrockConfig(env = process.env) {
  return {
    region: env.AWS_REGION || env.AWS_DEFAULT_REGION || '',
    accessKeyId: env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY || '',
    sessionToken: env.AWS_SESSION_TOKEN || '',
    modelId:
      env.BEDROCK_MODEL_ID || 'anthropic.claude-3-5-sonnet-20241022-v2:0',
  };
}

/** Whether a real call can be made. */
export function isBedrockConfigured(config = bedrockConfig()) {
  return Boolean(config.region && config.accessKeyId && config.secretAccessKey);
}

const sha256 = (value) =>
  createHash('sha256').update(value, 'utf8').digest('hex');
const hmac = (key, value) =>
  createHmac('sha256', key).update(value, 'utf8').digest();

/**
 * Sign a Bedrock InvokeModel request with SigV4.
 *
 * @param {object} input Signing input.
 * @param {object} input.config Resolved configuration.
 * @param {string} input.body Request body.
 * @param {Date} [input.now] Signing time.
 * @returns {{url: string, headers: object}} Signed request.
 */
export function signInvokeRequest({ config, body, now = new Date() }) {
  const host = `bedrock-runtime.${config.region}.amazonaws.com`;
  const path = `/model/${encodeURIComponent(config.modelId)}/invoke`;
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256(body);

  const headers = {
    'content-type': 'application/json',
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...(config.sessionToken
      ? { 'x-amz-security-token': config.sessionToken }
      : {}),
  };
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((key) => `${key}:${String(headers[key]).trim()}\n`)
    .join('');
  const canonicalRequest = [
    'POST',
    path,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${config.region}/${SERVICE}/aws4_request`;
  const stringToSign = [
    ALGORITHM,
    amzDate,
    scope,
    sha256(canonicalRequest),
  ].join('\n');
  const signingKey = hmac(
    hmac(
      hmac(hmac(`AWS4${config.secretAccessKey}`, dateStamp), config.region),
      SERVICE,
    ),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey)
    .update(stringToSign, 'utf8')
    .digest('hex');

  return {
    url: `https://${host}${path}`,
    headers: {
      ...headers,
      authorization: `${ALGORITHM} Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

/**
 * Invoke a Bedrock model with a system prompt and one user message.
 *
 * @param {object} input Invocation input.
 * @param {string} input.system System prompt.
 * @param {string} input.user User message.
 * @param {object} [input.config] Configuration override.
 * @param {Function} [input.fetchImpl] Transport, injectable for tests.
 * @param {number} [input.maxTokens] Response cap.
 * @returns {Promise<object>} Frozen result with `status` and `text`.
 */
export async function invokeBedrock({
  system,
  user,
  config = bedrockConfig(),
  fetchImpl = (...args) => fetch(...args),
  maxTokens = 400,
}) {
  if (!isBedrockConfigured(config))
    return Object.freeze({
      status: 'UNCONFIGURED',
      text: null,
      modelId: config.modelId,
      detail:
        'Set AWS_REGION, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY to enable Bedrock narration.',
    });

  const body = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: maxTokens,
    // Low temperature: this is a summarizer of supplied numbers, not an author.
    temperature: 0.2,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
  });

  try {
    const signed = signInvokeRequest({ config, body });
    const response = await fetchImpl(signed.url, {
      method: 'POST',
      headers: signed.headers,
      body,
      redirect: 'error',
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok)
      return Object.freeze({
        status: 'ERROR',
        text: null,
        modelId: config.modelId,
        detail: `Bedrock returned ${response.status}${payload?.message ? `: ${payload.message}` : ''}`,
      });
    const text = Array.isArray(payload?.content)
      ? payload.content
          .filter((part) => part?.type === 'text')
          .map((part) => part.text)
          .join('\n')
          .trim()
      : null;
    return Object.freeze({
      status: text ? 'READY' : 'ERROR',
      text: text || null,
      modelId: config.modelId,
      usage: payload?.usage ?? null,
      detail: text ? null : 'Bedrock returned no text content',
    });
  } catch (error) {
    return Object.freeze({
      status: 'ERROR',
      text: null,
      modelId: config.modelId,
      detail: error?.message || 'Bedrock request failed',
    });
  }
}
