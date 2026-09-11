/**
 * Live end-to-end check of a reasoning round trip through the gateway.
 *
 * Reproduces what a coding agent does: turn 1 asks a question, reads back the
 * emulated Responses output INCLUDING the reasoning item, then replays it as
 * history for turn 2. Before the fix this failed with
 *   "The `reasoning_content` in the thinking mode must be passed back to the API."
 *
 * Usage: node scripts/check-reasoning-live.mjs [gatewayUrl] [apiKey]
 */

const gateway = process.argv[2] ?? 'http://127.0.0.1:8317';
const apiKey = process.argv[3] ?? '';
const model = process.env.CHECK_MODEL ?? 'deepseek-flash';

const headers = { 'content-type': 'application/json' };
if (apiKey) headers.authorization = `Bearer ${apiKey}`;

async function responses(body) {
  const response = await fetch(`${gateway}/v1/responses`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, ...body }),
  });
  const text = await response.text();
  return { status: response.status, text };
}

function heading(title) {
  process.stdout.write(`\n${'='.repeat(74)}\n${title}\n${'='.repeat(74)}\n`);
}

let failures = 0;
const check = (ok, label, detail = '') => {
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `\n         ${detail}` : ''}\n`);
  if (!ok) failures += 1;
};

// ---------------------------------------------------------------- turn 1
heading(`Turn 1 — a fresh question against ${model}`);
const turn1 = await responses({
  input: 'What is 17 * 23? Think it through, then give the number.',
  max_output_tokens: 2000,
});

if (turn1.status !== 200) {
  check(false, `turn 1 failed with HTTP ${turn1.status}`, turn1.text.slice(0, 300));
  process.exit(1);
}
const body1 = JSON.parse(turn1.text);
const outputItems = body1.output ?? [];
process.stdout.write(`  status=${body1.status}  output items: ${outputItems.map((item) => item.type).join(', ')}\n`);

const reasoningItem = outputItems.find((item) => item.type === 'reasoning');
const messageItem = outputItems.find((item) => item.type === 'message');
check(reasoningItem !== undefined, 'turn 1 returned a reasoning item (what a client would replay)');
check(messageItem !== undefined, 'turn 1 returned a message item');

const reasoningText = (reasoningItem?.summary ?? []).map((part) => part.text ?? '').join('');
const answerText = (messageItem?.content ?? []).map((part) => part.text ?? '').join('');
process.stdout.write(`  reasoning: ${reasoningText.length} chars\n  answer   : ${JSON.stringify(answerText.slice(0, 80))}\n`);

// ---------------------------------------------------------------- turn 2
heading('Turn 2 — replay history WITH the reasoning item (the failing case)');
const replayedInput = [
  { role: 'user', content: [{ type: 'input_text', text: 'What is 17 * 23? Think it through, then give the number.' }] },
  ...(reasoningItem ? [{ type: 'reasoning', summary: reasoningItem.summary }] : []),
  { role: 'assistant', content: [{ type: 'output_text', text: answerText }] },
  { role: 'user', content: [{ type: 'input_text', text: 'Now double that number.' }] },
];

const turn2 = await responses({ input: replayedInput, max_output_tokens: 2000 });
if (turn2.status === 200) {
  const body2 = JSON.parse(turn2.text);
  const answer2 = (body2.output ?? [])
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content ?? [])
    .map((part) => part.text ?? '')
    .join('');
  check(true, 'turn 2 accepted the replayed reasoning (the reported failure is fixed)');
  process.stdout.write(`  answer: ${JSON.stringify(answer2.slice(0, 100))}\n`);
} else {
  let detail = turn2.text.slice(0, 400);
  try {
    const parsed = JSON.parse(turn2.text);
    detail = parsed?.error?.message ?? detail;
  } catch {
    /* keep raw */
  }
  check(false, `turn 2 failed with HTTP ${turn2.status}`, detail);
}

// ---------------------------------------------- turn 3: the old failure mode
heading('Turn 3 — replay WITHOUT the reasoning item (must still work, or fail clearly)');
const withoutReasoning = [
  { role: 'user', content: [{ type: 'input_text', text: 'What is 17 * 23?' }] },
  { role: 'assistant', content: [{ type: 'output_text', text: answerText }] },
  { role: 'user', content: [{ type: 'input_text', text: 'And double it.' }] },
];
const turn3 = await responses({ input: withoutReasoning, max_output_tokens: 2000 });
if (turn3.status === 200) {
  check(true, 'a history without reasoning is accepted (no reasoning_content required)');
} else {
  let detail = turn3.text.slice(0, 300);
  try {
    detail = JSON.parse(turn3.text)?.error?.message ?? detail;
  } catch {
    /* keep raw */
  }
  process.stdout.write(`  note: HTTP ${turn3.status} — ${detail}\n`);
  process.stdout.write('  (informational: the upstream itself requires reasoning here)\n');
}

// ------------------------------------------------ turn 4: streaming variant
heading('Turn 4 — streaming, with replayed reasoning');
const streamResponse = await fetch(`${gateway}/v1/responses`, {
  method: 'POST',
  headers: { ...headers, accept: 'text/event-stream' },
  body: JSON.stringify({ model, input: replayedInput, max_output_tokens: 1200, stream: true }),
});
const sse = await streamResponse.text();
const completed = sse
  .split('\n\n')
  .map((block) => block.split('\n').find((line) => line.startsWith('data:')))
  .filter(Boolean)
  .map((line) => {
    try {
      return JSON.parse(line.slice(5));
    } catch {
      return null;
    }
  })
  .filter(Boolean)
  .find((event) => event.type === 'response.completed');

check(streamResponse.status === 200 && completed !== undefined, 'streaming turn with replayed reasoning completed');
if (completed) {
  const out = (completed.response?.output ?? []).filter((item) => item.type === 'message');
  const text = out.flatMap((item) => item.content ?? []).map((part) => part.text ?? '').join('');
  process.stdout.write(`  answer: ${JSON.stringify(text.slice(0, 100))}\n`);
}

process.stdout.write(`\n${failures === 0 ? 'All reasoning round-trip checks passed.' : `${failures} check(s) failed.`}\n\n`);
process.exit(failures === 0 ? 0 : 1);
