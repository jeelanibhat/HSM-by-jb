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
export const STATUS_STYLE: Record<RoomStatus, { label: string; className: string }> = {
  VACANT_CLEAN: {
    label: 'Vacant clean',
    className: 'bg-status-vacant-clean/15 text-status-vacant-clean border-status-vacant-clean/30',
  },
  VACANT_DIRTY: {
    label: 'Vacant dirty',
    className: 'bg-status-vacant-dirty/15 text-status-vacant-dirty border-status-vacant-dirty/30',
  },
  OCCUPIED: {
    label: 'Occupied',
    className: 'bg-status-occupied/15 text-status-occupied border-status-occupied/30',
  },
  OOO: {
    label: 'Out of order',
    className: 'bg-status-ooo/15 text-status-ooo border-status-ooo/30',
  },
  OOS: {
    label: 'Out of service',
    className: 'bg-status-oos/15 text-status-oos border-status-oos/30',
  },
};
