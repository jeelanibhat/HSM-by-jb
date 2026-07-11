import { buildSchema, parse, validate } from 'graphql';
import { describe, expect, it } from 'vitest';
import { depthLimit } from './depth-limit.js';

/**
 * The depth limiter is a DoS control (TDD §5.3), so it gets tested like one:
 * the boundary is exact, fragments cannot be used to smuggle depth past it, and
 * a cyclic fragment must not take the process down with a stack overflow.
 */
const schema = buildSchema(`
  type Guest {
    id: ID!
    name: String!
    stays: [Reservation!]!
  }

  type Reservation {
    id: ID!
    guest: Guest!
    rooms: [ReservationRoom!]!
  }

  type ReservationRoom {
    id: ID!
    reservation: Reservation!
  }

  type Query {
    guest(id: ID!): Guest
    reservation(id: ID!): Reservation
  }
`);

function errorsFor(query: string, maxDepth: number): readonly string[] {
  return validate(schema, parse(query), [depthLimit(maxDepth)]).map((e) => e.message);
}

describe('depthLimit', () => {
  it('allows a query at exactly the limit', () => {
    // guest(1) → stays(2) → guest(3)
    const query = `{ guest(id: "1") { stays { guest { name } } } }`;
    expect(errorsFor(query, 4)).toEqual([]);
  });

  it('rejects a query one level past the limit', () => {
    const query = `{ guest(id: "1") { stays { guest { stays { id } } } } }`;
    const errors = errorsFor(query, 4);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/exceeds maximum depth of 4/);
  });

  it('reports the actual depth, not just the limit', () => {
    // guest(1) → stays(2) → guest(3) → stays(4) → rooms(5) → id(6)
    const query = `{ guest(id: "1") { stays { guest { stays { rooms { id } } } } } }`;
    expect(errorsFor(query, 3)[0]).toMatch(/\(got 6\)/);
  });

  it('allows a flat query', () => {
    expect(errorsFor(`{ guest(id: "1") { id name } }`, 8)).toEqual([]);
  });

  it('measures the deepest branch, not the last or the average', () => {
    const query = `
      {
        guest(id: "1") {
          name
          stays { rooms { reservation { guest { name } } } }
        }
      }
    `;
    // guest(1) → stays(2) → rooms(3) → reservation(4) → guest(5) → name(6)
    expect(errorsFor(query, 5)).toHaveLength(1);
    expect(errorsFor(query, 6)).toEqual([]);
  });

  // Fragments are the classic bypass: the query body looks shallow, the depth
  // hides in the fragment definition.
  it('counts depth through a fragment spread', () => {
    const query = `
      { guest(id: "1") { ...deep } }
      fragment deep on Guest {
        stays { guest { stays { rooms { id } } } }
      }
    `;
    expect(errorsFor(query, 4)).toHaveLength(1);
  });

  it('does not double-count an inline fragment as a level', () => {
    const query = `{ guest(id: "1") { ... on Guest { name } } }`;
    expect(errorsFor(query, 2)).toEqual([]);
  });

  // A self-referential fragment would recurse forever in a naive implementation
  // — turning the DoS guard itself into the DoS.
  it('terminates on a cyclic fragment instead of blowing the stack', () => {
    const query = `
      { guest(id: "1") { ...a } }
      fragment a on Guest { stays { guest { ...a } } }
    `;
    expect(() => errorsFor(query, 8)).not.toThrow();
  });

  it('ignores a fragment spread that has no definition', () => {
    const query = `{ guest(id: "1") { ...missing } }`;
    expect(() => errorsFor(query, 8)).not.toThrow();
  });

  it('does not count __typename or introspection meta-fields against the budget', () => {
    const query = `{ guest(id: "1") { __typename name } }`;
    expect(errorsFor(query, 2)).toEqual([]);
  });

  it('checks every operation in a multi-operation document', () => {
    const query = `
      query Shallow { guest(id: "1") { name } }
      query Deep { guest(id: "1") { stays { guest { stays { rooms { id } } } } } }
    `;
    expect(errorsFor(query, 3)).toHaveLength(1);
  });

  it('tags the error with a machine-readable code', () => {
    const query = `{ guest(id: "1") { stays { guest { stays { id } } } } }`;
    const errors = validate(schema, parse(query), [depthLimit(2)]);

    expect(errors[0]?.extensions?.['code']).toBe('QUERY_TOO_DEEP');
  });
});
