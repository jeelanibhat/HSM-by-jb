import { gql } from '@apollo/client';

export const ROOMS = gql`
  query Rooms {
    rooms {
      id
      number
      floor
      status
      statusNote
      roomTypeId
      allowedTransitions
    }
    roomTypes {
      id
      code
      name
    }
  }
`;

export const UPDATE_ROOM_STATUS = gql`
  mutation UpdateRoomStatus($input: UpdateRoomStatusGqlInput!) {
    updateRoomStatus(input: $input) {
      id
      number
      status
      statusNote
      allowedTransitions
    }
  }
`;

export type RoomStatus = 'VACANT_CLEAN' | 'VACANT_DIRTY' | 'OCCUPIED' | 'OOO' | 'OOS';

export interface Room {
  id: string;
  number: string;
  floor?: string | null;
  status: RoomStatus;
  statusNote?: string | null;
  roomTypeId: string;
  /** Computed server-side from the domain machine — never re-derived here. */
  allowedTransitions: RoomStatus[];
}

export interface RoomType {
  id: string;
  code: string;
  name: string;
}

/**
 * Status → token. The tokens live in globals.css and are shared with the tape
 * chart (TDD §7.2) — a room that reads "dirty" on one screen and "clean" on
 * another is how rooms get double-sold.
 */
export const STATUS_STYLE: Record<RoomStatus, { label: string; short: string; className: string }> = {
  VACANT_CLEAN: {
    label: 'Vacant clean',
    short: 'Clean',
    className: 'bg-status-vacant-clean/10 text-status-vacant-clean border-status-vacant-clean/25',
  },
  VACANT_DIRTY: {
    label: 'Vacant dirty',
    short: 'Dirty',
    className: 'bg-status-vacant-dirty/10 text-status-vacant-dirty border-status-vacant-dirty/25',
  },
  OCCUPIED: {
    label: 'Occupied',
    short: 'Occupied',
    className: 'bg-status-occupied/10 text-status-occupied border-status-occupied/25',
  },
  OOO: {
    label: 'Out of order',
    short: 'OOO',
    className: 'bg-status-ooo/10 text-status-ooo border-status-ooo/25',
  },
  OOS: {
    label: 'Out of service',
    short: 'OOS',
    className: 'bg-status-oos/10 text-status-oos border-status-oos/25',
  },
};
