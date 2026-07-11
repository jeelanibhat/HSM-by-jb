import { GraphQLError, Kind, type ASTNode, type ValidationContext } from 'graphql';

/**
 * Query depth limit (TDD §5.3). A public GraphQL endpoint without one is a
 * denial-of-service invitation: `reservation { guest { stays { reservation {
 * guest { ... } } } } }` nested 50 deep will happily melt the database.
 *
 * Rejected at validation time — before a single resolver or SQL query runs.
 */
export function depthLimit(maxDepth: number) {
  return (context: ValidationContext) => ({
    Document(node: ASTNode) {
      if (node.kind !== Kind.DOCUMENT) return;

      const fragments = Object.create(null) as Record<string, ASTNode>;
      for (const def of node.definitions) {
        if (def.kind === Kind.FRAGMENT_DEFINITION) {
          fragments[def.name.value] = def;
        }
      }

      for (const def of node.definitions) {
        if (def.kind !== Kind.OPERATION_DEFINITION) continue;

        const depth = measure(def, fragments, new Set());
        if (depth > maxDepth) {
          context.reportError(
            new GraphQLError(
              `Query exceeds maximum depth of ${maxDepth} (got ${depth}).`,
              { nodes: [def], extensions: { code: 'QUERY_TOO_DEEP', maxDepth, depth } },
            ),
          );
        }
      }
    },
  });
}

/**
 * `visited` guards against a fragment cycle — a self-referential fragment would
 * otherwise recurse until the stack blows, turning our DoS guard into the DoS.
 */
function measure(
  node: ASTNode,
  fragments: Record<string, ASTNode>,
  visited: ReadonlySet<string>,
): number {
  if (!('selectionSet' in node) || !node.selectionSet) return 0;

  let deepest = 0;

  for (const selection of node.selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      // Introspection meta-fields don't touch the DB; don't count them.
      if (selection.name.value.startsWith('__')) continue;
      deepest = Math.max(deepest, 1 + measure(selection, fragments, visited));
      continue;
    }

    if (selection.kind === Kind.INLINE_FRAGMENT) {
      // Inline fragments are not a level of nesting on their own.
      deepest = Math.max(deepest, measure(selection, fragments, visited));
      continue;
    }

    if (selection.kind === Kind.FRAGMENT_SPREAD) {
      const name = selection.name.value;
      if (visited.has(name)) continue; // cycle — stop descending

      const fragment = fragments[name];
      if (!fragment) continue;

      deepest = Math.max(deepest, measure(fragment, fragments, new Set([...visited, name])));
    }
  }

  return deepest;
}
