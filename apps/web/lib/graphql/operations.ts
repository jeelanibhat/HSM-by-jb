import { gql } from '@apollo/client';

/**
 * Hand-written for now. These get replaced by generated typed hooks once the
 * schema stops moving every hour (`pnpm codegen` against packages/graphql).
 */

export const LOGIN = gql`
  mutation Login($input: LoginInput!) {
    login(input: $input) {
      accessToken
      user {
        id
        email
        name
        roles {
          propertyId
          role
        }
      }
    }
  }
`;

export const REFRESH_TOKEN = gql`
  mutation RefreshToken {
    refreshToken {
      accessToken
      user {
        id
        email
        name
        roles {
          propertyId
          role
        }
      }
    }
  }
`;

export const LOGOUT = gql`
  mutation Logout {
    logout
  }
`;

export const MY_PROPERTIES = gql`
  query MyProperties {
    myProperties {
      id
      name
      currency
      timezone
      businessDate
    }
  }
`;

export const CURRENT_PROPERTY = gql`
  query CurrentProperty {
    currentProperty {
      id
      name
      currency
      timezone
      businessDate
      checkInTime
      checkOutTime
      status
    }
  }
`;

export interface PropertyRole {
  propertyId: string;
  role: string;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  roles: PropertyRole[];
}

export interface Property {
  id: string;
  name: string;
  currency: string;
  timezone: string;
  businessDate: string;
  checkInTime?: string;
  checkOutTime?: string;
  status?: string;
}
