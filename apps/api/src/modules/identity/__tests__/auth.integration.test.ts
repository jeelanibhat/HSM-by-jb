/**
 * Auth, tenancy and RBAC against the real stack (TDD §8.1 "API contract").
 *
 * Boots the actual Nest application — real guards, real Postgres with RLS, real
 * Valkey sessions. Mocking any of those would test the mock: the guard order, the
 * RLS policies and the Lua rotation script are the things under test here.
 *
 * Requires `pnpm db:up` + `pnpm db:migrate` + `pnpm db:seed`.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../../app.module';

const ALPHA = '11111111-1111-1111-1111-111111111111';
const BETA = '22222222-2222-2222-2222-222222222222';
const PASSWORD = 'Password123!';

const LOGIN = `
  mutation($input: LoginInput!) {
    login(input: $input) {
      accessToken
      user { id email roles { propertyId role } }
    }
  }
`;
const ME = `{ me { email roles { propertyId role } } }`;
const CURRENT_PROPERTY = `{ currentProperty { id name } }`;
const MY_PROPERTIES = `{ myProperties { id name } }`;
const REFRESH = `mutation { refreshToken { accessToken user { email } } }`;

let app: INestApplication;

interface GqlOpts {
  token?: string;
  propertyId?: string;
  cookie?: string;
}

function gql(query: string, variables?: unknown, opts: GqlOpts = {}) {
  const req = request(app.getHttpServer()).post('/graphql');

  if (opts.token) req.set('Authorization', `Bearer ${opts.token}`);
  if (opts.propertyId) req.set('X-Property-Id', opts.propertyId);
  if (opts.cookie) req.set('Cookie', opts.cookie);

  return req.send({ query, variables });
}

async function login(email: string) {
  const res = await gql(LOGIN, { input: { email, password: PASSWORD } });
  const setCookie = res.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  const cookie = /hotelos_rt=[^;]+/.exec(raw ?? '')?.[0];

  return {
    token: res.body.data?.login?.accessToken as string,
    user: res.body.data?.login?.user,
    cookie: cookie ?? '',
    res,
  };
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();
}, 60_000);

afterAll(async () => {
  await app?.close();
});

describe('login', () => {
  it('issues an access token for valid credentials', async () => {
    const { token, user } = await login('frontdesk@hotelos.dev');

    expect(token).toBeTruthy();
    expect(user.email).toBe('frontdesk@hotelos.dev');
  });

  it('rejects a wrong password', async () => {
    const res = await gql(LOGIN, {
      input: { email: 'frontdesk@hotelos.dev', password: 'nope' },
    });
    expect(res.body.errors).toBeTruthy();
  });

  /**
   * A different error (or a materially different response time) for an unknown
   * email turns the login form into an account-enumeration oracle.
   */
  it('gives an unknown email the SAME error as a wrong password', async () => {
    const wrongPassword = await gql(LOGIN, {
      input: { email: 'frontdesk@hotelos.dev', password: 'nope' },
    });
    const unknownUser = await gql(LOGIN, {
      input: { email: 'ghost@hotelos.dev', password: PASSWORD },
    });

    expect(unknownUser.body.errors[0].message).toBe(wrongPassword.body.errors[0].message);
  });

  it('puts the refresh token in an httpOnly cookie, never in the payload', async () => {
    const { res } = await login('frontdesk@hotelos.dev');
    const setCookie = res.headers['set-cookie'];
    const raw = Array.isArray(setCookie) ? setCookie[0] : (setCookie ?? '');

    expect(raw).toMatch(/hotelos_rt=/);
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Lax/i);

    // If the refresh token were in the JSON, an XSS payload could read it and the
    // httpOnly flag would be pointless.
    expect(JSON.stringify(res.body)).not.toMatch(/hotelos_rt/);
    expect(res.body.data.login.refreshToken).toBeUndefined();
  });

  it('returns the roles the user actually holds, per property', async () => {
    const { user } = await login('frontdesk@hotelos.dev');
    expect(user.roles).toEqual([{ propertyId: ALPHA, role: 'FRONT_DESK' }]);
  });
});

describe('authentication is on by default', () => {
  it('rejects an unauthenticated query', async () => {
    const res = await gql(ME);
    expect(res.body.errors).toBeTruthy();
  });

  it('allows @Public() endpoints without a token', async () => {
    const res = await gql(`{ health { status } }`);
    expect(res.body.data.health.status).toBe('ok');
  });

  /** Both are signed JWTs. Only `typ` distinguishes them. */
  it('refuses a REFRESH token used as an ACCESS token', async () => {
    const { cookie } = await login('frontdesk@hotelos.dev');
    const rawToken = decodeURIComponent(cookie.replace('hotelos_rt=', ''));

    const res = await gql(ME, undefined, { token: rawToken });
    expect(res.body.errors).toBeTruthy();
  });
});

describe('property context (X-Property-Id is hostile input)', () => {
  it('requires the header on a scoped operation', async () => {
    const { token } = await login('frontdesk@hotelos.dev');
    const res = await gql(CURRENT_PROPERTY, undefined, { token });

    expect(res.body.errors).toBeTruthy();
  });

  it('allows a property the user holds a role at', async () => {
    const { token } = await login('frontdesk@hotelos.dev');
    const res = await gql(CURRENT_PROPERTY, undefined, { token, propertyId: ALPHA });

    expect(res.body.data.currentProperty.name).toBe('Hotel Alpha');
  });

  /** THE attack: a valid token, and a header naming someone else's hotel. */
  it('refuses a property the user has no role at, even with a valid token', async () => {
    const { token } = await login('frontdesk@hotelos.dev');
    const res = await gql(CURRENT_PROPERTY, undefined, { token, propertyId: BETA });

    expect(res.body.errors).toBeTruthy();
    expect(res.body.data?.currentProperty).toBeFalsy();
  });

  it('rejects a malformed property id before it can reach set_config', async () => {
    const { token } = await login('frontdesk@hotelos.dev');
    const res = await gql(CURRENT_PROPERTY, undefined, {
      token,
      propertyId: "'; DROP TABLE property.properties; --",
    });

    expect(res.body.errors).toBeTruthy();
  });

  it('does not reveal whether the property exists or the user merely lacks access', async () => {
    const { token } = await login('frontdesk@hotelos.dev');

    const realButForbidden = await gql(CURRENT_PROPERTY, undefined, { token, propertyId: BETA });
    const doesNotExist = await gql(CURRENT_PROPERTY, undefined, {
      token,
      propertyId: '99999999-9999-9999-9999-999999999999',
    });

    expect(doesNotExist.body.errors[0].message).toBe(realButForbidden.body.errors[0].message);
  });
});

describe('property switcher', () => {
  it('shows a single-property user only their property', async () => {
    const { token } = await login('frontdesk@hotelos.dev');
    const res = await gql(MY_PROPERTIES, undefined, { token });

    expect(res.body.data.myProperties).toHaveLength(1);
    expect(res.body.data.myProperties[0].name).toBe('Hotel Alpha');
  });

  it('shows a multi-property admin both, with the correct data for each', async () => {
    const { token } = await login('admin@hotelos.dev');

    const list = await gql(MY_PROPERTIES, undefined, { token });
    expect(list.body.data.myProperties).toHaveLength(2);

    const alpha = await gql(CURRENT_PROPERTY, undefined, { token, propertyId: ALPHA });
    const beta = await gql(CURRENT_PROPERTY, undefined, { token, propertyId: BETA });

    // Each scoped request must return ITS OWN property — not a cached or bled one.
    expect(alpha.body.data.currentProperty).toMatchObject({ id: ALPHA, name: 'Hotel Alpha' });
    expect(beta.body.data.currentProperty).toMatchObject({ id: BETA, name: 'Hotel Beta' });
  });

  it('shows a Beta-only user only Beta (isolation holds in both directions)', async () => {
    const { token } = await login('beta.frontdesk@hotelos.dev');

    const list = await gql(MY_PROPERTIES, undefined, { token });
    expect(list.body.data.myProperties).toHaveLength(1);
    expect(list.body.data.myProperties[0].name).toBe('Hotel Beta');

    const alpha = await gql(CURRENT_PROPERTY, undefined, { token, propertyId: ALPHA });
    expect(alpha.body.errors).toBeTruthy();
  });
});

describe('refresh rotation and reuse detection', () => {
  it('rotates the token on every refresh', async () => {
    const { cookie } = await login('frontdesk@hotelos.dev');

    const res = await gql(REFRESH, undefined, { cookie });
    const setCookie = res.headers['set-cookie'];
    const raw = Array.isArray(setCookie) ? setCookie[0] : (setCookie ?? '');
    const rotated = /hotelos_rt=[^;]+/.exec(raw)?.[0];

    expect(res.body.data.refreshToken.accessToken).toBeTruthy();
    expect(rotated).toBeTruthy();
    expect(rotated).not.toBe(cookie);
  });

  /**
   * The stolen-token scenario. A spent refresh token must not work again — and
   * because we cannot tell the thief from the victim, its reuse must burn the
   * whole family. Otherwise a stolen token is a permanent, silent backdoor.
   */
  it('rejects a replayed token AND revokes the entire family', async () => {
    const { cookie: original } = await login('frontdesk@hotelos.dev');

    const first = await gql(REFRESH, undefined, { cookie: original });
    const setCookie = first.headers['set-cookie'];
    const raw = Array.isArray(setCookie) ? setCookie[0] : (setCookie ?? '');
    const rotated = /hotelos_rt=[^;]+/.exec(raw)?.[0] ?? '';

    // Replay the spent one.
    const replay = await gql(REFRESH, undefined, { cookie: original });
    expect(replay.body.errors).toBeTruthy();

    // The legitimate rotated token must ALSO be dead now — that is the point.
    const afterReuse = await gql(REFRESH, undefined, { cookie: rotated });
    expect(
      afterReuse.body.errors,
      'family was not revoked — a stolen refresh token would still work',
    ).toBeTruthy();
  });

  it('rejects a refresh with no cookie at all', async () => {
    const res = await gql(REFRESH);
    expect(res.body.errors).toBeTruthy();
  });
});
