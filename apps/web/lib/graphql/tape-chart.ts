import { gql } from '@apollo/client';

export const TAPE_CHART = gql`
  query TapeChart($from: String!, $to: String!) {
    tapeChart(from: $from, to: $to) {
      from
      to
      dates
      rooms {
        id
        number
        floor
        status
        roomTypeId
        roomTypeCode
      }
      blocks {
        reservationRoomId
        reservationId
        roomId
        confirmationNo
        guestName
        status
        arrivalDate
        departureDate
      }
      unassigned {
        reservationRoomId
        reservationId
        confirmationNo
        guestName
        status
        roomTypeId
        roomTypeCode
        arrivalDate
        departureDate
      }
    }
  }
`;

export const TAPE_CHART_CHANGED = gql`
  subscription TapeChartChanged($propertyId: ID!) {
    tapeChartChanged(propertyId: $propertyId) {
      eventType
      reservationId
      occurredAt
    }
  }
`;

export const ASSIGN_ROOM = gql`
  mutation AssignRoom($input: AssignRoomGqlInput!) {
    assignRoom(input: $input) {
      id
      roomId
    }
  }
`;

export const MODIFY_RESERVATION = gql`
  mutation ModifyReservation($input: ModifyReservationGqlInput!) {
    modifyReservation(input: $input) {
      id
      arrivalDate
      departureDate
    }
  }
`;

export interface ChartRoom {
  id: string;
  number: string;
  floor?: string | null;
  status: string;
  roomTypeId: string;
  roomTypeCode: string;
}

export interface ChartBlock {
  reservationRoomId: string;
  reservationId: string;
  roomId: string;
  confirmationNo: string;
  guestName: string;
  status: string;
  arrivalDate: string;
  departureDate: string;
}

export interface UnassignedBlock {
  reservationRoomId: string;
  reservationId: string;
  confirmationNo: string;
  guestName: string;
  status: string;
  roomTypeId: string;
  roomTypeCode: string;
  arrivalDate: string;
  departureDate: string;
}

export interface TapeChartData {
  from: string;
  to: string;
  dates: string[];
  rooms: ChartRoom[];
  blocks: ChartBlock[];
  unassigned: UnassignedBlock[];
}

/** Reservation status → colour token. Shared with the room board (TDD §7.2). */
export const RES_STATUS_STYLE: Record<string, string> = {
  ENQUIRY: 'bg-res-enquiry text-white',
  CONFIRMED: 'bg-res-confirmed text-white',
  CHECKED_IN: 'bg-res-checked-in text-white',
  CHECKED_OUT: 'bg-res-checked-out text-white',
  CANCELLED: 'bg-res-cancelled text-white',
  NO_SHOW: 'bg-res-no-show text-white',
};
