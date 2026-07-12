import { gql } from '@apollo/client';

export const FRONT_DESK_BOARD = gql`
  query FrontDeskBoard($date: String!) {
    frontDeskBoard(date: $date) {
      businessDate
      arrivals { ...deskRow }
      departures { ...deskRow }
      inHouse { ...deskRow }
    }
  }

  fragment deskRow on FrontDeskRowGql {
    reservationId
    reservationRoomId
    confirmationNo
    guestId
    guestName
    vip
    status
    roomId
    roomNumber
    roomTypeId
    roomTypeCode
    arrivalDate
    departureDate
    adults
    children
    folioId
    balanceMinor
  }
`;

export const CHECK_IN = gql`
  mutation CheckIn($reservationId: ID!) {
    checkIn(reservationId: $reservationId) {
      folioId
      reservation { id status }
    }
  }
`;

export const CHECK_OUT = gql`
  mutation CheckOut($reservationId: ID!) {
    checkOut(reservationId: $reservationId) {
      folioId
      reservation { id status }
    }
  }
`;

export const AVAILABLE_ROOMS = gql`
  query AvailableRooms {
    rooms { id number floor status roomTypeId }
  }
`;

export const FOLIO = gql`
  query Folio($id: ID!) {
    folio(id: $id) {
      id
      folioNo
      status
      currency
      balanceMinor
      lines {
        id
        businessDate
        type
        code
        description
        amountMinor
        taxAmountMinor
        voided
        reversesLineId
        reason
      }
    }
  }
`;

export const POST_CHARGE = gql`
  mutation PostCharge($input: PostChargeGqlInput!) {
    postCharge(input: $input) { charges payments tax balance currency }
  }
`;

export const POST_PAYMENT = gql`
  mutation PostPayment($input: PostPaymentGqlInput!) {
    postPayment(input: $input) { charges payments tax balance currency }
  }
`;

export const VOID_LINE = gql`
  mutation VoidFolioLine($input: VoidLineGqlInput!) {
    voidFolioLine(input: $input) { balance }
  }
`;

export interface DeskRow {
  reservationId: string;
  reservationRoomId: string;
  confirmationNo: string;
  guestId: string;
  guestName: string;
  vip: boolean;
  status: string;
  roomId?: string | null;
  roomNumber?: string | null;
  roomTypeId: string;
  roomTypeCode: string;
  arrivalDate: string;
  departureDate: string;
  adults: number;
  children: number;
  folioId?: string | null;
  balanceMinor: number;
}

export interface FolioLine {
  id: string;
  businessDate: string;
  type: 'CHARGE' | 'PAYMENT' | 'TAX' | 'ADJUSTMENT';
  code: string;
  description: string;
  amountMinor: number;
  taxAmountMinor: number;
  voided: boolean;
  reversesLineId?: string | null;
  reason?: string | null;
}

export interface Folio {
  id: string;
  folioNo: string;
  status: string;
  currency: string;
  balanceMinor: number;
  lines: FolioLine[];
}

/** The codes a receptionist actually posts. Free text would make reports useless. */
export const CHARGE_CODES = ['ROOM', 'F&B', 'LAUNDRY', 'MINIBAR', 'SPA', 'MISC'] as const;
export const PAYMENT_CODES = ['CASH', 'CARD', 'UPI', 'BANK_TRANSFER'] as const;
