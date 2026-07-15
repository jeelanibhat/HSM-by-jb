import { gql } from '@apollo/client';

export interface Outlet {
  id: string;
  code: string;
  name: string;
  chargeCode: string;
}

export interface MenuItem {
  id: string;
  code: string;
  name: string;
  category: string | null;
  priceMinor: number;
}

export interface OrderLine {
  id: string;
  menuItemId: string;
  description: string;
  unitPriceMinor: number;
  quantity: number;
  notes: string | null;
}

export interface PosOrder {
  id: string;
  outletId: string;
  orderNo: string;
  status: 'OPEN' | 'CHARGED' | 'VOID';
  tableRef: string | null;
  lines: OrderLine[];
  /** Tax excluded — the folio adds it. */
  subtotalMinor: number;
}

/** A name and a room number. Never a balance. */
export interface ChargeableRoom {
  roomId: string;
  roomNumber: string;
  guestName: string;
}

const ORDER_FIELDS = `
  id
  outletId
  orderNo
  status
  tableRef
  subtotalMinor
  lines {
    id
    menuItemId
    description
    unitPriceMinor
    quantity
    notes
  }
`;

export const POS_SETUP = gql`
  query PosSetup {
    outlets {
      id
      code
      name
      chargeCode
    }
    chargeableRooms {
      roomId
      roomNumber
      guestName
    }
  }
`;

export const MENU = gql`
  query Menu($outletId: ID!) {
    menu(outletId: $outletId) {
      id
      code
      name
      category
      priceMinor
    }
  }
`;

export const OPEN_ORDERS = gql`
  query OpenOrders($outletId: ID) {
    openOrders(outletId: $outletId) { ${ORDER_FIELDS} }
  }
`;

export const OPEN_ORDER = gql`
  mutation OpenOrder($input: OpenOrderGqlInput!) {
    openOrder(input: $input) { ${ORDER_FIELDS} }
  }
`;

export const ADD_LINE = gql`
  mutation AddOrderLine($input: AddOrderLineGqlInput!) {
    addOrderLine(input: $input) { ${ORDER_FIELDS} }
  }
`;

export const REMOVE_LINE = gql`
  mutation RemoveOrderLine($input: RemoveOrderLineGqlInput!) {
    removeOrderLine(input: $input) { ${ORDER_FIELDS} }
  }
`;

export const CHARGE_TO_ROOM = gql`
  mutation ChargeOrderToRoom($input: ChargeOrderToRoomGqlInput!) {
    chargeOrderToRoom(input: $input) {
      roomNumber
      chargedMinor
      order { ${ORDER_FIELDS} }
    }
  }
`;

export const VOID_ORDER = gql`
  mutation VoidOrder($input: VoidOrderGqlInput!) {
    voidOrder(input: $input) { ${ORDER_FIELDS} }
  }
`;
