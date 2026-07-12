import { gql } from '@apollo/client';

export const BOOKING_OPTIONS = gql`
  query BookingOptions {
    roomTypes { id code name baseOccupancy maxOccupancy }
    ratePlans { id code name currency mealPlan }
  }
`;

export const AVAILABILITY = gql`
  query Availability($from: String!, $to: String!) {
    availability(from: $from, to: $to) {
      roomTypeId
      date
      total
      sold
      blocked
      available
    }
  }
`;

/** Priced server-side. The browser never sums rates or estimates tax. */
export const QUOTE = gql`
  query Quote(
    $roomTypeId: ID!
    $ratePlanId: ID!
    $arrivalDate: String!
    $departureDate: String!
  ) {
    quote(
      roomTypeId: $roomTypeId
      ratePlanId: $ratePlanId
      arrivalDate: $arrivalDate
      departureDate: $departureDate
    ) {
      nights
      currency
      nightly { date priceMinor }
      subtotalMinor
      taxMinor
      totalMinor
      unpricedDates
    }
  }
`;

export const SEARCH_GUESTS = gql`
  query SearchGuests($query: String!) {
    searchGuests(query: $query) {
      id
      firstName
      lastName
      email
      phone
      vip
      blacklisted
    }
  }
`;

export const CREATE_RESERVATION = gql`
  mutation CreateReservation($input: CreateReservationGqlInput!) {
    createReservation(input: $input) {
      id
      confirmationNo
      status
      arrivalDate
      departureDate
      rooms { id }
    }
  }
`;

export interface RoomType {
  id: string;
  code: string;
  name: string;
  baseOccupancy: number;
  maxOccupancy: number;
}

export interface RatePlan {
  id: string;
  code: string;
  name: string;
  currency: string;
  mealPlan: string;
}

export interface AvailabilityRow {
  roomTypeId: string;
  date: string;
  total: number;
  sold: number;
  blocked: number;
  available: number;
}

export interface QuoteNight {
  date: string;
  priceMinor: number;
}

export interface Quote {
  nights: number;
  currency: string;
  nightly: QuoteNight[];
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  unpricedDates: string[];
}

export interface GuestHit {
  id: string;
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
  vip: boolean;
  blacklisted: boolean;
}

export const SOURCES = ['WALK_IN', 'DIRECT', 'PHONE', 'OTA', 'BOOKING_ENGINE'] as const;
