import { Field, ID, InputType, ObjectType, registerEnumType } from '@nestjs/graphql';
import { ROLES, type Role } from '@hotelos/domain';

/** Mirrors the domain enum so the SDL and the DB cannot drift apart. */
export const RoleEnum = Object.fromEntries(ROLES.map((r) => [r, r])) as Record<Role, Role>;
registerEnumType(RoleEnum, {
  name: 'Role',
  description: 'A role held at a specific property. There are no global roles.',
});

@ObjectType()
export class PropertyRoleType {
  @Field(() => ID)
  propertyId!: string;

  @Field(() => RoleEnum)
  role!: Role;
}

@ObjectType()
export class UserType {
  @Field(() => ID)
  id!: string;

  @Field()
  email!: string;

  @Field()
  name!: string;

  @Field(() => [PropertyRoleType])
  roles!: PropertyRoleType[];
}

/**
 * Note what is NOT here: the refresh token. It leaves the server only as an
 * httpOnly cookie, so no JavaScript — ours or an XSS payload's — can ever read it
 * (TDD §3). Returning it in the GraphQL payload would defeat the entire point.
 */
@ObjectType()
export class AuthPayload {
  @Field()
  accessToken!: string;

  @Field(() => UserType)
  user!: UserType;
}

@InputType()
export class LoginInput {
  @Field()
  email!: string;

  @Field()
  password!: string;
}
