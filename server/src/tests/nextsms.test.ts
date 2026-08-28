import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NextSmsProvider,
  authorizationHeader,
  errorText,
} from '../modules/communication/providers/nextsms.js';

/** What a school reads in the outbox when the gateway turns a send down. */
describe('NextSMS error text', () => {
  it('lifts the sentence out of the gateway JSON', () => {
    expect(errorText('{"message":"Invalid sender id"}')).toBe('Invalid sender id');
    expect(errorText('{"error":"Insufficient balance"}')).toBe('Insufficient balance');
  });

  it('keeps anything it does not recognise, rather than hiding it', () => {
    expect(errorText('<html>502 Bad Gateway</html>')).toBe('<html>502 Bad Gateway</html>');
    expect(errorText('{"code":42}')).toBe('{"code":42}');
  });

  it('says so when there is no body at all', () => {
    expect(errorText('   ')).toBe('no response body');
  });

  it('caps a runaway body so one failure cannot fill the outbox', () => {
    expect(errorText(JSON.stringify({ message: 'x'.repeat(500) })).length).toBe(200);
  });
});

/**
 * The dashboard shows a ready-made token, so whichever of the two forms a
 * school has to hand has to produce the same header.
 */
describe('NextSMS authorization', () => {
  const encoded = Buffer.from('school:secret').toString('base64');

  it('encodes a username and password when no token is given', () => {
    expect(authorizationHeader(undefined, 'school', 'secret')).toBe(`Basic ${encoded}`);
  });

  it('takes a token pasted with its scheme exactly as it is', () => {
    expect(authorizationHeader(`Basic ${encoded}`, '', '')).toBe(`Basic ${encoded}`);
    expect(authorizationHeader(`Bearer ${encoded}`, '', '')).toBe(`Bearer ${encoded}`);
  });

  it('assumes Basic for a bare token, which is what the dashboard encodes', () => {
    expect(authorizationHeader(encoded, '', '')).toBe(`Basic ${encoded}`);
  });

  it('tolerates the whitespace that comes with a copy and paste', () => {
    expect(authorizationHeader(`  ${encoded}\n`, '', '')).toBe(`Basic ${encoded}`);
  });

  it('prefers the token, since it is the credential the school actually copied', () => {
    expect(authorizationHeader('pasted-token', 'school', 'secret')).toBe('Basic pasted-token');
  });

  it('falls back to the username and password when the token is blank', () => {
    expect(authorizationHeader('   ', 'school', 'secret')).toBe(`Basic ${encoded}`);
  });
});

/**
 * NextSMS (messaging-service.co.tz): Basic auth, a JSON body, and one entry per
 * recipient in `messages` whose `status.groupName` says what happened.
 */
describe('NextSMS request and response handling', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const ok = (body: unknown) =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    } as unknown as Response);

  const accepted = (numbers: string[]) => ({
    messages: numbers.map((to, i) => ({
      to,
      status: { groupId: 1, groupName: 'PENDING', id: 26, name: 'MESSAGE_ACCEPTED' },
      messageId: `msg-${i}`,
      smsCount: 1,
    })),
  });

  const provider = () => new NextSmsProvider('school', 'secret', false, 'https://gw.test/api/sms/v1');

  it('authenticates with Basic credentials and posts JSON', async () => {
    fetchMock.mockReturnValue(ok(accepted(['255754000001'])));

    await provider().send([{ recipient: '+255754000001', body: 'Results are out.' }], 'SHULE');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://gw.test/api/sms/v1/text/single');
    expect(init.headers.Authorization).toBe(
      `Basic ${Buffer.from('school:secret').toString('base64')}`,
    );
    expect(init.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ from: 'SHULE', text: 'Results are out.' });
  });

  it('sends one destination as a bare string, not an array of one', async () => {
    fetchMock.mockReturnValue(ok(accepted(['255754000001'])));

    await provider().send([{ recipient: '+255754000001', body: 'x' }], 'SHULE');

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.to).toBe('255754000001');
  });

  it('strips the plus, because the gateway wants bare digits', async () => {
    fetchMock.mockReturnValue(ok(accepted(['255754000001', '255754000002'])));

    await provider().send(
      [
        { recipient: '+255754000001', body: 'x' },
        { recipient: '+255754000002', body: 'x' },
      ],
      'SHULE',
    );

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.to).toEqual(['255754000001', '255754000002']);
  });

  it('uses the test path, which does not send or bill', async () => {
    fetchMock.mockReturnValue(ok(accepted(['255754000001'])));

    await new NextSmsProvider('u', 'p', true, 'https://gw.test/api/sms/v1').send(
      [{ recipient: '+255754000001', body: 'x' }],
      'SHULE',
    );

    expect(fetchMock.mock.calls[0]![0]).toBe('https://gw.test/api/sms/v1/test/text/single');
  });

  it('sends one identical announcement as a single request to many numbers', async () => {
    fetchMock.mockReturnValue(ok(accepted(['255754000001', '255754000002'])));

    await provider().send(
      [
        { recipient: '+255754000001', body: 'Parents meeting on Saturday.' },
        { recipient: '+255754000002', body: 'Parents meeting on Saturday.' },
      ],
      'SHULE',
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://gw.test/api/sms/v1/text/single');
  });

  it('sends personalised messages in one multi request, not one each', async () => {
    fetchMock.mockReturnValue(
      ok({
        messages: ['255754000001', '255754000002', '255754000003'].map((to, i) => ({
          to,
          status: { groupName: 'PENDING', name: 'MESSAGE_ACCEPTED' },
          messageId: `m${i}`,
          smsCount: 1,
        })),
      }),
    );

    // A result notice per child: every body differs, which would otherwise be
    // one HTTP request per parent.
    const results = await provider().send(
      [
        { recipient: '+255754000001', body: 'Asha scored 72%' },
        { recipient: '+255754000002', body: 'Juma scored 65%' },
        { recipient: '+255754000003', body: 'Neema scored 81%' },
      ],
      'SHULE',
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://gw.test/api/sms/v1/text/multi');

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.messages).toHaveLength(3);
    expect(body.messages[0]).toMatchObject({
      from: 'SHULE',
      to: '255754000001',
      text: 'Asha scored 72%',
    });
    expect(results.every((r) => r.accepted)).toBe(true);
  });

  it('accepts a pending message and records its id and segment count', async () => {
    fetchMock.mockReturnValue(
      ok({
        messages: [
          {
            to: '255754000001',
            status: { groupName: 'PENDING', name: 'MESSAGE_ACCEPTED' },
            messageId: 'abc123',
            smsCount: 2,
          },
        ],
      }),
    );

    const [result] = await provider().send(
      [{ recipient: '+255754000001', body: 'x' }],
      'SHULE',
    );

    expect(result).toMatchObject({ accepted: true, providerRef: 'abc123', cost: '2 SMS' });
  });

  it('does not retry a rejected number, but does retry an empty balance', async () => {
    fetchMock.mockReturnValue(
      ok({
        messages: [
          {
            to: '255754000001',
            status: {
              groupName: 'REJECTED',
              name: 'REJECTED_INVALID_DESTINATION',
              description: 'Invalid destination address',
            },
          },
          {
            to: '255754000002',
            status: {
              groupName: 'REJECTED',
              name: 'REJECTED_NOT_ENOUGH_CREDIT',
              description: 'Not enough credit',
            },
          },
        ],
      }),
    );

    const results = await provider().send(
      [
        { recipient: '+255754000001', body: 'x' },
        { recipient: '+255754000002', body: 'x' },
      ],
      'SHULE',
    );

    expect(results[0]).toMatchObject({ accepted: false, retryable: false });
    expect(results[0]!.error).toContain('Invalid destination');
    // Topping up fixes this one, so it must survive to be retried.
    expect(results[1]).toMatchObject({ accepted: false, retryable: true });
  });

  it('treats bad credentials as permanent and a timeout as retryable', async () => {
    fetchMock.mockReturnValue(
      Promise.resolve({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Unauthorized'),
        json: () => Promise.resolve({}),
      } as unknown as Response),
    );
    const unauthorised = await provider().send(
      [{ recipient: '+255754000001', body: 'x' }],
      'SHULE',
    );
    expect(unauthorised[0]).toMatchObject({ accepted: false, retryable: false });

    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new Error('The operation timed out'));
    const timedOut = await provider().send([{ recipient: '+255754000001', body: 'x' }], 'SHULE');
    expect(timedOut[0]).toMatchObject({ accepted: false, retryable: true });
  });

  it('does not retry a rejected sender ID reported for the whole request', async () => {
    fetchMock.mockReturnValue(ok({ messages: [], error: 'Invalid sender id' }));

    const [result] = await provider().send(
      [{ recipient: '+255754000001', body: 'x' }],
      'BADSENDER',
    );

    expect(result).toMatchObject({ accepted: false, retryable: false });
  });

  it('never throws when the gateway returns nonsense', async () => {
    fetchMock.mockReturnValue(
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.reject(new Error('not json')),
        text: () => Promise.resolve('<html>'),
      } as unknown as Response),
    );

    const results = await provider().send([{ recipient: '+255754000001', body: 'x' }], 'SHULE');
    expect(results).toHaveLength(1);
    expect(results[0]!.accepted).toBe(false);
  });

  it('sends with a dashboard token and no username or password', async () => {
    fetchMock.mockReturnValue(ok(accepted(['255754000001'])));

    await new NextSmsProvider('', '', false, 'https://gw.test/api/sms/v1', 'tok123').send(
      [{ recipient: '+255754000001', body: 'x' }],
      'SHULE',
    );

    expect(fetchMock.mock.calls[0]![1].headers.Authorization).toBe('Basic tok123');
  });

  it('omits the sender ID when blank, so the account default applies', async () => {
    fetchMock.mockReturnValue(ok(accepted(['255754000001'])));

    await provider().send([{ recipient: '+255754000001', body: 'x' }], '  ');

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.from).toBeUndefined();
  });
});
