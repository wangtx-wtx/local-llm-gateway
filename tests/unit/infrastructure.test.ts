import { describe, expect, it } from 'vitest';
import { Semaphore } from '../../src/infra/semaphore.js';
import { CircuitBreaker } from '../../src/infra/circuit-breaker.js';
import { classifyIp, validateUrlShape, validateUpstreamUrl } from '../../src/security/ssrf.js';
import { SecretBox, generateMasterKey, isSecretEnvelope, parseMasterKey, safeEqual } from '../../src/infra/crypto.js';

describe('Semaphore', () => {
  it('grants up to the limit immediately', async () => {
    const semaphore = new Semaphore(2, 4);
    const first = await semaphore.acquire();
    const second = await semaphore.acquire();
    expect(semaphore.active).toBe(2);
    expect(semaphore.queued).toBe(0);
    first.release();
    second.release();
    expect(semaphore.active).toBe(0);
  });

  it('queues waiters in FIFO order', async () => {
    const semaphore = new Semaphore(1, 4);
    const held = await semaphore.acquire();
    const order: number[] = [];
    const third = semaphore.acquire().then((lease) => {
      order.push(3);
      lease.release();
    });
    const second = semaphore.acquire().then((lease) => {
      order.push(2);
      lease.release();
    });
    expect(semaphore.queued).toBe(2);
    held.release();
    await Promise.all([second, third]);
    expect(order).toEqual([3, 2]);
  });

  it('rejects with a queue-full error when the queue is saturated', async () => {
    const semaphore = new Semaphore(1, 1);
    const held = await semaphore.acquire();
    const waiting = semaphore.acquire();
    await expect(semaphore.acquire()).rejects.toMatchObject({ kind: 'queue_full_error' });
    held.release();
    (await waiting).release();
  });

  it('makes release idempotent so double-release cannot inflate capacity', async () => {
    const semaphore = new Semaphore(1, 2);
    const lease = await semaphore.acquire();
    lease.release();
    lease.release();
    expect(semaphore.active).toBe(0);
    const again = await semaphore.acquire();
    expect(semaphore.active).toBe(1);
    again.release();
  });

  it('removes an aborted waiter without leaking a slot', async () => {
    const semaphore = new Semaphore(1, 4);
    const held = await semaphore.acquire();
    const controller = new AbortController();
    const pending = semaphore.acquire(controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeDefined();
    expect(semaphore.queued).toBe(0);
    held.release();
    const after = await semaphore.acquire();
    expect(semaphore.active).toBe(1);
    after.release();
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const semaphore = new Semaphore(2, 2);
    const controller = new AbortController();
    controller.abort();
    await expect(semaphore.acquire(controller.signal)).rejects.toBeDefined();
    expect(semaphore.active).toBe(0);
  });
});

describe('CircuitBreaker', () => {
  it('opens after the configured number of consecutive failures', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1_000 });
    expect(breaker.canPass()).toBe(true);
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.canPass()).toBe(true);
    breaker.recordFailure();
    expect(breaker.canPass()).toBe(false);
    expect(breaker.snapshot().state).toBe('open');
  });

  it('resets the failure count after a success', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1_000 });
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    breaker.recordFailure();
    // Only two consecutive failures after the success.
    expect(breaker.canPass()).toBe(true);
  });

  it('half-opens after the cooldown and closes on a successful probe', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 100 });
    breaker.recordFailure(1_000);
    expect(breaker.canPass(1_050)).toBe(false);
    expect(breaker.tryStartProbe(1_100)).toBe(true);
    breaker.recordSuccess();
    expect(breaker.snapshot(1_100).state).toBe('closed');
  });

  it('returns to open when a half-open probe fails', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 100 });
    breaker.recordFailure(1_000);
    expect(breaker.tryStartProbe(1_100)).toBe(true);
    breaker.recordFailure(1_150);
    // The probe failed, so the breaker re-opens rather than staying half-open.
    expect(breaker.snapshot(1_150).state).toBe('open');
    expect(breaker.canPass(1_150)).toBe(false);
  });

  it('backs off exponentially when reopened repeatedly', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 100 });
    breaker.recordFailure(1_000);
    const firstWindow = (breaker.snapshot(1_000).cooldownUntil ?? 0) - 1_000;
    // Cooldown elapses → probe → probe fails → a longer cooldown than before.
    expect(breaker.tryStartProbe(1_000 + firstWindow)).toBe(true);
    breaker.recordFailure(1_000 + firstWindow);
    const secondWindow = (breaker.snapshot(1_000 + firstWindow).cooldownUntil ?? 0) - (1_000 + firstWindow);
    expect(secondWindow).toBeGreaterThan(firstWindow);
  });

  it('caps the exponential backoff', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 100 });
    let now = 0;
    for (let round = 0; round < 12; round += 1) {
      const window = (breaker.snapshot(now).cooldownUntil ?? 0) - now;
      now += Math.max(window, 1);
      breaker.tryStartProbe(now);
      breaker.recordFailure(now);
    }
    const capped = (breaker.snapshot(now).cooldownUntil ?? 0) - now;
    // 30x the base cooldown is the documented ceiling.
    expect(capped).toBeLessThanOrEqual(3_000);
  });

  it('forceOpen makes an unhealthy credential permanently unusable', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 5, cooldownMs: 10 });
    breaker.forceOpen();
    expect(breaker.canPass()).toBe(false);
    expect(breaker.snapshot().cooldownUntil).toBe(Number.POSITIVE_INFINITY);
    // No amount of elapsed time revives it — only an explicit reset or probe.
    expect(breaker.canPass(Date.now() + 10 * 365 * 86_400_000)).toBe(false);
  });

  it('reset restores normal operation', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 60_000 });
    breaker.recordFailure();
    expect(breaker.canPass()).toBe(false);
    breaker.reset();
    expect(breaker.canPass()).toBe(true);
    expect(breaker.snapshot().state).toBe('closed');
  });
});

describe('SSRF classification', () => {
  it('flags cloud metadata addresses as metadata', () => {
    expect(classifyIp('169.254.169.254')).toBe('metadata');
    expect(classifyIp('100.100.100.200')).toBe('metadata');
    expect(classifyIp('fd00:ec2::254')).toBe('metadata');
  });

  it('classifies loopback, private, link-local, CGNAT and reserved ranges', () => {
    expect(classifyIp('127.0.0.1')).toBe('loopback');
    expect(classifyIp('::1')).toBe('loopback');
    expect(classifyIp('10.0.0.5')).toBe('private');
    expect(classifyIp('172.16.3.4')).toBe('private');
    expect(classifyIp('192.168.1.1')).toBe('private');
    expect(classifyIp('169.254.10.10')).toBe('link_local');
    // CGNAT is non-routable and reported as private (both are blocked classes).
    expect(['private', 'cgnat']).toContain(classifyIp('100.64.0.1'));
    expect(classifyIp('240.0.0.1')).toBe('reserved');
  });

  it('treats a public IPv4 address as public', () => {
    expect(classifyIp('8.8.8.8')).toBe('public');
    expect(classifyIp('1.1.1.1')).toBe('public');
  });

  it('handles IPv4-mapped IPv6 addresses', () => {
    expect(classifyIp('::ffff:127.0.0.1')).toBe('loopback');
    expect(classifyIp('::ffff:169.254.169.254')).toBe('metadata');
  });
});

describe('validateUrlShape', () => {
  it('accepts http and https URLs', () => {
    expect(validateUrlShape('https://api.example.com/v1').ok).toBe(true);
    expect(validateUrlShape('http://127.0.0.1:8080/v1').ok).toBe(true);
  });

  it('rejects non-HTTP schemes', () => {
    expect(validateUrlShape('file:///etc/passwd').ok).toBe(false);
    expect(validateUrlShape('ftp://example.com').ok).toBe(false);
    expect(validateUrlShape('gopher://example.com').ok).toBe(false);
  });

  it('rejects embedded credentials', () => {
    const result = validateUrlShape('https://user:pass@example.com/v1');
    expect(result.ok).toBe(false);
  });

  it('rejects a metadata hostname regardless of DNS', () => {
    expect(validateUrlShape('http://metadata.google.internal/computeMetadata/v1').ok).toBe(false);
  });
});

describe('validateUpstreamUrl with injected DNS', () => {
  it('blocks a public hostname that resolves to a metadata address', async () => {
    await expect(
      validateUpstreamUrl('https://innocent.example.com/v1', {
        allowPrivateNetwork: true,
        resolve: async () => [{ address: '169.254.169.254', family: 4 }],
      }),
    ).rejects.toThrow(/metadata/i);
  });

  it('blocks a loopback target unless private networks are allowed', async () => {
    await expect(
      validateUpstreamUrl('http://localhost:11434/v1', {
        allowPrivateNetwork: false,
        resolve: async () => [{ address: '127.0.0.1', family: 4 }],
      }),
    ).rejects.toBeDefined();

    const allowed = await validateUpstreamUrl('http://localhost:11434/v1', {
      allowPrivateNetwork: true,
      resolve: async () => [{ address: '127.0.0.1', family: 4 }],
    });
    expect(allowed.addresses.map((entry) => entry.address)).toContain('127.0.0.1');
  });

  it('pins the connection to the validated addresses', async () => {
    const target = await validateUpstreamUrl('https://api.example.com/v1', {
      allowPrivateNetwork: false,
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    });
    expect(target.addresses.map((entry) => entry.address)).toEqual(['93.184.216.34']);
    expect(target.hostname).toBe('api.example.com');
    expect(target.tls).toBe(true);
  });

  it('rejects the request when DNS fails rather than falling through', async () => {
    await expect(
      validateUpstreamUrl('https://unresolvable.example.invalid/v1', {
        allowPrivateNetwork: true,
        resolve: async () => {
          throw new Error('ENOTFOUND');
        },
      }),
    ).rejects.toBeDefined();
  });
});

describe('SecretBox', () => {
  it('round-trips a secret', () => {
    const box = new SecretBox(generateMasterKey());
    const envelope = box.encrypt('sk-super-secret-value');
    expect(envelope).not.toContain('sk-super-secret-value');
    expect(isSecretEnvelope(envelope)).toBe(true);
    expect(box.decrypt(envelope)).toBe('sk-super-secret-value');
  });

  it('produces a different ciphertext each time (random IV)', () => {
    const box = new SecretBox(generateMasterKey());
    expect(box.encrypt('same')).not.toBe(box.encrypt('same'));
  });

  it('fails to decrypt with the wrong key instead of returning garbage', () => {
    const first = new SecretBox(generateMasterKey());
    const second = new SecretBox(generateMasterKey());
    const envelope = first.encrypt('secret');
    expect(() => second.decrypt(envelope)).toThrow();
  });

  it('rejects tampered ciphertext', () => {
    const box = new SecretBox(generateMasterKey());
    const envelope = JSON.parse(box.encrypt('secret')) as { ct: string };
    const tampered = Buffer.from(envelope.ct, 'base64');
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    envelope.ct = tampered.toString('base64');
    expect(() => box.decrypt(JSON.stringify(envelope))).toThrow();
  });

  it('requires a 32-byte key', () => {
    expect(() => new SecretBox(Buffer.alloc(16))).toThrow();
  });
});

describe('parseMasterKey', () => {
  it('accepts hex and base64 encodings of 32 bytes', () => {
    const key = generateMasterKey();
    expect(parseMasterKey(key.toString('hex')).equals(key)).toBe(true);
    expect(parseMasterKey(key.toString('base64')).equals(key)).toBe(true);
  });

  it('rejects a key of the wrong length or format', () => {
    expect(() => parseMasterKey('too-short')).toThrow();
    expect(() => parseMasterKey('')).toThrow();
  });
});

describe('safeEqual', () => {
  it('compares equal and unequal strings correctly', () => {
    expect(safeEqual('abc123', 'abc123')).toBe(true);
    expect(safeEqual('abc123', 'abc124')).toBe(false);
    expect(safeEqual('short', 'muchlongervalue')).toBe(false);
  });
});
