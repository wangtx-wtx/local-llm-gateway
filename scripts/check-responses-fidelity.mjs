/**
 * Probes how faithfully an emulated Responses endpoint behaves on the features
 * that have NO chat-completions equivalent.
 *
 * The point is to distinguish three outcomes, which matter very differently to an
 * agent:
 *   preserved   — behaves as the real Responses API does
 *   clear error — fails loudly, so the agent can fall back
 *   SILENT LOSS — returns HTTP 200 but quietly drops something (the dangerous one)
 *
 * Usage: node scripts/check-responses-fidelity.mjs [gatewayUrl] [apiKey] [model]
 */

const gateway = process.argv[2] ?? 'http://127.0.0.1:8317';
const apiKey = process.argv[3] ?? '';
const model = process.argv[4] ?? process.env.CHECK_MODEL ?? 'deepseek-flash';

const headers = { 'content-type': 'application/json' };
if (apiKey) headers.authorization = `Bearer ${apiKey}`;

async function call(body) {
  const response = await fetch(`${gateway}/v1/responses`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, ...body }),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* SSE or non-JSON */
  }
  return { status: response.status, text, json };
}

function heading(title) {
  process.stdout.write(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}\n`);
}

function verdict(kind, label, detail = '') {
  const tag = kind === 'preserved' ? 'PRESERVED  ' : kind === 'error' ? 'CLEAR ERROR' : 'SILENT LOSS';
  process.stdout.write(`  [${tag}] ${label}${detail ? `\n                ${detail}` : ''}\n`);
}

async function main() {
  const health = await fetch(`${gateway}/health`).catch(() => null);
  if (!health?.ok) {
    process.stderr.write(`\nCannot reach a gateway at ${gateway}.\n`);
    process.exit(1);
  }

  // ------------------------------------------------------------------ 1
  heading('1. previous_response_id (server-side conversation state)');
  const first = await call({ input: 'My favourite colour is teal. Just acknowledge.', max_output_tokens: 800 });
  if (first.status !== 200 || !first.json) {
    verdict('error', `turn 1 failed: HTTP ${first.status}`, first.text.slice(0, 160));
  } else {
    const responseId = first.json.id;
    process.stdout.write(`  turn 1 id: ${responseId}\n`);

    // The agent sends ONLY the id plus the new turn - no history at all.
    const second = await call({
      input: 'What is my favourite colour?',
      previous_response_id: responseId,
      max_output_tokens: 800,
    });
    if (second.status !== 200) {
      verdict('error', `turn 2 rejected with HTTP ${second.status}`, second.text.slice(0, 200));
    } else {
      const answer = (second.json?.output ?? [])
        .filter((item) => item.type === 'message')
        .flatMap((item) => item.content ?? [])
        .map((part) => part.text ?? '')
        .join('');
      const remembered = /teal/i.test(answer);
      verdict(
        remembered ? 'preserved' : 'lost',
        remembered ? 'the model remembered the earlier turn' : 'the model did NOT remember (context dropped)',
        `answer: ${JSON.stringify(answer.slice(0, 110))}`,
      );
      if (!remembered) {
        process.stdout.write(
          '                The gateway is stateless, so `previous_response_id` cannot resolve.\n' +
            '                HTTP 200 with lost context is worse than an error: the agent cannot tell.\n',
        );
      }
    }
  }

  // ------------------------------------------------------------------ 2
  heading('2. store: true (persist the response server-side)');
  const stored = await call({ input: 'Say OK.', store: true, max_output_tokens: 800 });
  if (stored.status !== 200) {
    verdict('error', `HTTP ${stored.status}`, stored.text.slice(0, 160));
  } else {
    verdict(
      'lost',
      'accepted with HTTP 200 but nothing is stored (the gateway is stateless)',
      'harmless unless the agent later relies on the id',
    );
  }

  // ------------------------------------------------------------------ 3
  heading('3. Hosted tools that a chat upstream cannot execute');
  const hosted = await call({
    input: 'What is the weather in Shanghai right now?',
    tools: [{ type: 'web_search' }],
    max_output_tokens: 800,
  });
  if (hosted.status !== 200) {
    verdict('error', `HTTP ${hosted.status}`, hosted.text.slice(0, 200));
  } else {
    const usedSearch = JSON.stringify(hosted.json ?? {}).includes('web_search_call');
    verdict(
      usedSearch ? 'preserved' : 'lost',
      usedSearch ? 'a web_search_call item was produced' : 'the tool was dropped; the model answered unaided',
      'no error is raised - the request simply proceeds without the tool',
    );
  }

  // ------------------------------------------------------------------ 4
  heading('4. Structured output (text.format json_schema)');
  const structured = await call({
    input: 'Return the numbers 1 and 2.',
    text: { format: { type: 'json_schema', name: 'pair', schema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] }, strict: true } },
    max_output_tokens: 800,
  });
  if (structured.status !== 200) {
    verdict('error', `HTTP ${structured.status}`, structured.text.slice(0, 200));
  } else {
    const text = (structured.json?.output ?? [])
      .filter((item) => item.type === 'message')
      .flatMap((item) => item.content ?? [])
      .map((part) => part.text ?? '')
      .join('');
    let valid = false;
    try {
      const parsed = JSON.parse(text);
      valid = typeof parsed.a === 'number' && typeof parsed.b === 'number';
    } catch {
      valid = false;
    }
    verdict(valid ? 'preserved' : 'lost', valid ? 'returned schema-conforming JSON' : 'did not return valid JSON', `raw: ${JSON.stringify(text.slice(0, 90))}`);
  }

  // ------------------------------------------------------------------ 5
  heading('5. Usage detail (cached input tokens)');
  const usageProbe = await call({ input: 'Say OK.', max_output_tokens: 800 });
  const usage = usageProbe.json?.usage;
  if (!usage) {
    verdict('lost', 'no usage block returned');
  } else {
    const hasDetails = usage.input_tokens_details !== undefined || usage.output_tokens_details !== undefined;
    verdict(
      hasDetails ? 'preserved' : 'lost',
      hasDetails ? 'input/output token details present' : 'details omitted (upstream reported none)',
      JSON.stringify(usage),
    );
  }

  // ------------------------------------------------------------------ 6
  heading('6. Reasoning item round-trip (the DeepSeek failure mode)');
  const reasoned = await call({ input: 'What is 12*12? Think then answer.', max_output_tokens: 1200 });
  const items = (reasoned.json?.output ?? []).map((item) => item.type);
  const reasoning = (reasoned.json?.output ?? []).find((item) => item.type === 'reasoning');
  const message = (reasoned.json?.output ?? []).find((item) => item.type === 'message');
  if (reasoning && message) {
    const replay = await call({
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'What is 12*12? Think then answer.' }] },
        { type: 'reasoning', summary: reasoning.summary },
        { role: 'assistant', content: message.content },
        { role: 'user', content: [{ type: 'input_text', text: 'Add 1 to that.' }] },
      ],
      max_output_tokens: 1200,
    });
    verdict(
      replay.status === 200 ? 'preserved' : 'error',
      replay.status === 200 ? 'replaying the reasoning item is accepted' : `replay rejected: HTTP ${replay.status}`,
      replay.status === 200 ? '' : replay.text.slice(0, 200),
    );
    process.stdout.write(`  output items on turn 1: ${items.join(', ')}\n`);
  } else {
    verdict('error', `no reasoning item produced (items: ${items.join(', ') || 'none'})`);
  }

  process.stdout.write('\n');
}

await main();
