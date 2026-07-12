/**
 * Guest PII (TDD §9): "encrypted at rest (column-level for id_number), masked in
 * logs, audit-logged access for exports. Data-retention job for GDPR/DPDP erasure."
 *
 * The assertion that matters most reads the RAW COLUMN as the database owner and
 * proves the plaintext is not in there. Everything else is downstream of that.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import type postgres from 'postgres';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../../app.module';
import { ownerClient } from '../../../test/db';

const ALPHA = '11111111-1111-1111-1111-111111111111';
const BETA = '22222222-2222-2222-2222-222222222222';
const PASSWORD = 'Password123!';
const PASSPORT = 'P8837291X';

let app: INestApplication;
let owner: postgres.Sql;
const tok: Record<string, string> = {};

function gql(query: string, variables?: unknown, token = tok['admin'], propertyId = ALPHA) {
  return request(app.getHttpServer())
    .post('/graphql')
    .set('Authorization', `Bearer ${token}`)
    .set('X-Property-Id', propertyId)
    .send({ query, variables });
}

async function login(email: string) {
  const res = await request(app.getHttpServer())
    .post('/graphql')
    .send({
      query: `mutation($i: LoginInput!) { login(input: $i) { accessToken } }`,
      variables: { i: { email, password: PASSWORD } },
    });
  return res.body.data.login.accessToken as string;
}

const CREATE = `
  mutation($i: CreateGuestGqlInput!) {
    createGuest(input: $i) { id firstName lastName idNumberMasked vip blacklisted }
  }
`;
const REVEAL = `mutation($i: RevealIdGqlInput!) { revealIdNumber(input: $i) }`;
const SEARCH = `query($q: String!) { searchGuests(query: $q) { id firstName lastName idNumberMasked } }`;
const BY_ID_NUMBER = `query($n: String!) { guestByIdNumber(idNumber: $n) { id firstName idNumberMasked } }`;
const ANONYMISE = `mutation($i: AnonymiseGuestGqlInput!) { anonymiseGuest(input: $i) { id firstName lastName idNumberMasked anonymisedAt } }`;

async function newGuest(last = 'Rao', idNumber: string | undefined = PASSPORT) {
  const res = await gql(CREATE, {
    i: {
      firstName: 'Priya',
      lastName: last,
      email: `priya.${Date.now()}@example.com`,
      idType: 'PASSPORT',
      ...(idNumber ? { idNumber } : {}),
    },
  });
  return res.body.data.createGuest as { id: string; idNumberMasked: string | null };
}

/** The raw row, as the DBA / a stolen backup would see it. */
async function rawRow(id: string) {
  const [row] = await owner`SELECT * FROM guests.guests WHERE id = ${id}`;
  return row!;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();

  owner = ownerClient();
  for (const who of ['admin', 'manager', 'frontdesk', 'housekeeping']) {
    tok[who] = await login(`${who}@hotelos.dev`);
  }
}, 90_000);

afterAll(async () => {
  await owner`DELETE FROM guests.guests WHERE property_id IN (${ALPHA}, ${BETA})`;
  await owner?.end();
  await app?.close();
});

afterEach(async () => {
  await owner`
    DELETE FROM guests.guests
    WHERE property_id IN (${ALPHA}, ${BETA})
      AND id NOT IN (SELECT guest_id FROM reservations.reservations)
  `;
});

describe('encryption at rest — the whole point', () => {
  it('NEVER stores the ID number in plaintext', async () => {
    const guest = await newGuest();
    const row = await rawRow(guest.id);

    // Read every text-ish column as a stolen dump would, and prove the passport
    // number is in none of them.
    const dump = JSON.stringify(row);

    expect(
      dump.includes(PASSPORT),
      'the passport number is sitting in plaintext in the database',
    ).toBe(false);

    // The legacy plaintext column is gone entirely — migration 0017 contracted it away.
    // Not "empty": ABSENT. An empty column is one careless INSERT from being full again.
    expect(
      Object.keys(row),
      'the plaintext id_number column is back',
    ).not.toContain('id_number');

    expect(row['id_number_encrypted']).toBeTruthy();
    expect(String(row['id_number_encrypted'])).toMatch(/^v1:/);
  });

  it('produces DIFFERENT ciphertext for the same number each time', async () => {
    const a = await newGuest('First');
    const b = await newGuest('Second');

    const rowA = await rawRow(a.id);
    const rowB = await rawRow(b.id);

    // A fixed IV would make the ciphertext column itself leak "these two guests
    // share an ID", which is most of what you wanted to hide.
    expect(rowA['id_number_encrypted']).not.toBe(rowB['id_number_encrypted']);
  });

  it('stores a deterministic blind index so the same number is findable', async () => {
    const a = await newGuest('Alpha');
    const b = await newGuest('Beta');

    const rowA = await rawRow(a.id);
    const rowB = await rawRow(b.id);

    // The hash IS deterministic — that is what makes lookup possible, and it is
    // the accepted trade for searchability.
    expect(rowA['id_number_hash']).toBe(rowB['id_number_hash']);

    // ...but it is not the number, and not a bare hash of it.
    expect(String(rowA['id_number_hash'])).not.toContain(PASSPORT);
  });

  it('round-trips the value correctly', async () => {
    const guest = await newGuest();

    const res = await gql(REVEAL, {
      i: { guestId: guest.id, reason: 'Verifying at check-in' },
    });

    expect(res.body.data.revealIdNumber).toBe(PASSPORT);
  });

  it('normalises case and whitespace for the blind index', async () => {
    await newGuest('Exact', 'ab-1234 ');

    // 'ab-1234 ' and 'AB-1234' are the same person.
    const found = await gql(BY_ID_NUMBER, { n: 'AB-1234' });
    expect(found.body.data.guestByIdNumber).toBeTruthy();
    expect(found.body.data.guestByIdNumber.firstName).toBe('Priya');
  });
});

describe('the ID number does not leak through ordinary reads', () => {
  it('is not a field on the Guest type at all', async () => {
    const guest = await newGuest();

    const res = await gql(`query($id: ID!) { guest(id: $id) { id idNumber } }`, {
      id: guest.id,
    });

    // The schema itself must refuse this. If `idNumber` were ever added to GuestGql,
    // this test fails and someone has to justify it.
    expect(res.body.errors).toBeTruthy();
    expect(res.body.errors[0].message).toMatch(/cannot query field "idNumber"/i);
  });

  it('exposes only the last four digits', async () => {
    const guest = await newGuest();

    expect(guest.idNumberMasked).toBe('••••291X'.replace('291X', PASSPORT.slice(-4)));
    expect(guest.idNumberMasked).not.toContain(PASSPORT.slice(0, 4));
  });

  it('does not return it in search results', async () => {
    await newGuest('Searchable');

    const res = await gql(SEARCH, { q: 'Searchable' });
    const body = JSON.stringify(res.body);

    expect(res.body.data.searchGuests.length).toBeGreaterThan(0);
    expect(body.includes(PASSPORT), 'search results carried the full ID number').toBe(false);
  });

  it('finds a returning guest by exact ID number without exposing it', async () => {
    const created = await newGuest('Returning');

    const res = await gql(BY_ID_NUMBER, { n: PASSPORT });

    expect(res.body.data.guestByIdNumber.id).toBe(created.id);
    expect(JSON.stringify(res.body).includes(PASSPORT)).toBe(false);
  });
});

/**
 * TDD §9: "audit-logged access for exports".
 */
describe('every reveal is audited', () => {
  it('records who looked, and why, in the same transaction', async () => {
    const guest = await newGuest();
    await owner`DELETE FROM shared.audit_log WHERE entity_id = ${guest.id}`;

    await gql(REVEAL, { i: { guestId: guest.id, reason: 'Police request #4417' } });

    const audits = await owner`
      SELECT action, reason, user_id FROM shared.audit_log
      WHERE entity_id = ${guest.id} AND action = 'guest.id_number_revealed'
    `;

    expect(audits, 'an ID number was revealed with no audit trail').toHaveLength(1);
    expect(audits[0]?.['reason']).toBe('Police request #4417');
    expect(audits[0]?.['user_id']).toBeTruthy();
  });

  it('refuses a reveal with no reason', async () => {
    const guest = await newGuest();

    const res = await gql(REVEAL, { i: { guestId: guest.id, reason: '' } });
    expect(res.body.errors[0].message).toMatch(/reason is required/i);
  });

  it('does not copy the number into the audit log itself', async () => {
    const guest = await newGuest();

    await gql(REVEAL, { i: { guestId: guest.id, reason: 'Checking' } });

    const audits = await owner`SELECT * FROM shared.audit_log WHERE entity_id = ${guest.id}`;

    // An audit log that faithfully records the passport number into a second,
    // append-only, never-encrypted table defeats the entire point of encrypting
    // the first one.
    expect(
      JSON.stringify(audits).includes(PASSPORT),
      'the audit log leaked the very PII it exists to protect',
    ).toBe(false);
  });

  it('refuses front desk and housekeeping — they only need the last four', async () => {
    const guest = await newGuest();

    for (const who of ['frontdesk', 'housekeeping']) {
      const res = await gql(
        REVEAL,
        { i: { guestId: guest.id, reason: 'Curiosity' } },
        tok[who],
      );
      expect(res.body.errors[0].message).toMatch(/insufficient permissions/i);
    }
  });

  it('allows a manager', async () => {
    const guest = await newGuest();

    const res = await gql(
      REVEAL,
      { i: { guestId: guest.id, reason: 'Guest lost their passport' } },
      tok['manager'],
    );
    expect(res.body.data.revealIdNumber).toBe(PASSPORT);
  });
});

/**
 * TDD §9: "Data-retention job for GDPR/DPDP erasure requests."
 */
describe('erasure', () => {
  it('destroys the personal data but keeps the row', async () => {
    const guest = await newGuest('Forgettable');

    const res = await gql(ANONYMISE, {
      i: { guestId: guest.id, reason: 'DPDP erasure request' },
    });

    expect(res.body.data.anonymiseGuest.firstName).toBe('Erased');
    expect(res.body.data.anonymiseGuest.idNumberMasked).toBeNull();
    expect(res.body.data.anonymiseGuest.anonymisedAt).toBeTruthy();

    const row = await rawRow(guest.id);

    // The row SURVIVES — folios and invoices point at it, and a hard delete would
    // either cascade away financial history or leave dangling references.
    expect(row['id']).toBe(guest.id);

    // ...but nothing personal is left in it.
    expect(row['id_number_encrypted']).toBeNull();
    expect(row['id_number_hash']).toBeNull();
    expect(row['email']).toBeNull();
    expect(row['phone']).toBeNull();
    expect(JSON.stringify(row).includes(PASSPORT)).toBe(false);
  });

  it('makes the guest unfindable by their old ID number', async () => {
    const guest = await newGuest('Gone');
    await gql(ANONYMISE, { i: { guestId: guest.id, reason: 'Erasure' } });

    const found = await gql(BY_ID_NUMBER, { n: PASSPORT });
    expect(found.body.data.guestByIdNumber).toBeNull();
  });

  it('cannot reveal an ID number that has been erased', async () => {
    const guest = await newGuest('Erased');
    await gql(ANONYMISE, { i: { guestId: guest.id, reason: 'Erasure' } });

    const res = await gql(REVEAL, { i: { guestId: guest.id, reason: 'Trying anyway' } });
    expect(res.body.errors[0].message).toMatch(/no id number on file/i);
  });

  it('is idempotent', async () => {
    const guest = await newGuest('Twice');

    await gql(ANONYMISE, { i: { guestId: guest.id, reason: 'First' } });
    const second = await gql(ANONYMISE, { i: { guestId: guest.id, reason: 'Second' } });

    expect(second.body.errors).toBeFalsy();
    expect(second.body.data.anonymiseGuest.firstName).toBe('Erased');
  });

  it('is admin-only — erasure is irreversible', async () => {
    const guest = await newGuest();

    const res = await gql(
      ANONYMISE,
      { i: { guestId: guest.id, reason: 'Manager trying' } },
      tok['manager'],
    );
    expect(res.body.errors[0].message).toMatch(/insufficient permissions/i);
  });

  it('audits the erasure without recording what was erased', async () => {
    const guest = await newGuest('Audited');
    await owner`DELETE FROM shared.audit_log WHERE entity_id = ${guest.id}`;

    await gql(ANONYMISE, { i: { guestId: guest.id, reason: 'DPDP request #99' } });

    const audits = await owner`
      SELECT * FROM shared.audit_log WHERE entity_id = ${guest.id} AND action = 'guest.anonymised'
    `;
    expect(audits).toHaveLength(1);
    expect(audits[0]?.['reason']).toBe('DPDP request #99');
    expect(JSON.stringify(audits).includes(PASSPORT)).toBe(false);
  });
});

describe('tenancy', () => {
  it('does not leak guests across properties', async () => {
    await newGuest('AlphaOnly');

    const betaSearch = await gql(SEARCH, { q: 'AlphaOnly' }, tok['admin'], BETA);
    expect(betaSearch.body.data.searchGuests).toEqual([]);

    const betaLookup = await gql(BY_ID_NUMBER, { n: PASSPORT }, tok['admin'], BETA);
    expect(betaLookup.body.data.guestByIdNumber).toBeNull();
  });
});

describe('search', () => {
  it('finds by full name typed as one string', async () => {
    await newGuest('Chatterjee', undefined);

    const res = await gql(SEARCH, { q: 'Priya Chatterjee' });
    expect(res.body.data.searchGuests.length).toBeGreaterThan(0);
  });

  it('ignores a query too short to be meaningful', async () => {
    const res = await gql(SEARCH, { q: 'a' });
    expect(res.body.data.searchGuests).toEqual([]);
  });
});
