# @hotelos/graphql

`schema.graphql` is **generated**, not authored. It is emitted by `apps/api` on boot
(NestJS code-first, `autoSchemaFile`) and consumed by `apps/web`'s GraphQL Codegen.

It is committed on purpose: it makes schema changes visible in review, and it lets
CI diff the SDL to catch a breaking API change before it reaches a client.

Do not edit it by hand. To change the schema, change the resolvers/types in
`apps/api/src/modules/**/graphql/` and restart the API.
